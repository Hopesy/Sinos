export interface TerminalStatus { model?: string; cwd?: string; lines: string[]; contextUsed?: number }

// Ink's composer rules occupy a whole terminal row. A stale VT wrap flag
// must not glue one to the prompt/HUD and turn it into a long chat paragraph.
export const isTerminalRule = (line: string) => /^[\s─━═┄┈]{8,}$/.test(line) && /[─━═┄┈]/.test(line);
const prompt = /^\s{0,3}[❯›>](?:\s|$)/;
const hud = /^\s*\[[^\]\n]{1,80}\](?:\s|$)/;
const effort = /^[◐◑◒◓◔◕◈]\s*(?:low|medium|high|max|xhigh|auto)(?:\s+effort)?\s*[·•]\s*\/effort$/i;
const hint = /^(?:[⏸⏵▶▸]\s*)?(?:manual mode on|accept edits on|bypass permissions on|plan mode on|\? for shortcuts|esc to interrupt|ctrl\+c to interrupt|shift\+tab\b|.*[←→].*for agents)|^◈.*\/effort|^\d[\d,.kKmM]*\s+tokens\b/i;
const bar = /[░▒▓█▏▎▍▌▋▊▉▰▱━─]{3,}/g;

/** Only controls adjacent to a bordered CLI composer are status chrome.
 * Keep code samples and similarly worded assistant output in the timeline. */
export function claudeChrome(lines: string[], code: Set<number>) {
  const hidden = new Set<number>();
  let status: TerminalStatus | undefined;
  const first = lines.findIndex(line => line.trim());
  const startupHeader = first >= 0 && /^[\s▐▛▜▝▘█▗▟▄▀·]*Claude Code\s+v\d[\w.+-]*$/.test(lines[first]) && /\b(?:Opus|Sonnet|Haiku|context|API Usage Billing)\b/i.test(lines[first + 1] || '');
  const previous = (from: number) => { let i = from - 1; while (i >= 0 && !lines[i].trim()) i--; return i; };
  const next = (from: number) => { let i = from + 1; while (i < lines.length && !lines[i].trim()) i++; return i; };
  // The initial header can arrive in a separate PTY write, before the
  // composer. Do not expose its indentation as Markdown code for a frame.
  if (startupHeader) {
    for (let j = first; j < Math.min(lines.length, first + 3); j++) hidden.add(j);
    // /effort may be painted one write before the composer border arrives.
    lines.forEach((line, index) => { if (effort.test(line.trim())) hidden.add(index); });
  }
  for (let i = 0; i < lines.length; i++) {
    if (!code.has(i) && /[▐▛▜▝▘█].*Claude Code\s+v\d/.test(lines[i]) && lines.slice(i + 1, i + 3).every(line => /[▐▛▜▝▘█]/.test(line))) {
      hidden.add(i); hidden.add(i + 1); hidden.add(i + 2);
    }
    if (code.has(i) || !prompt.test(lines[i])) continue;
    const top = previous(i), bottom = next(i);
    if (top < 0 || bottom >= lines.length || !isTerminalRule(lines[top]) || !isTerminalRule(lines[bottom])) continue;
    hidden.add(i); hidden.add(top); hidden.add(bottom);
    // The mascot appears after the first frame. Before it is painted the
    // version, model and directory are indented like code. Require both the
    // startup header at the beginning and this live composer as evidence.
    if (startupHeader && first + 2 < top) {
      hidden.add(first); hidden.add(first + 1); hidden.add(first + 2);
    }
    // Ink right-aligns /effort above the composer. Its indentation looks like
    // Markdown code; only remove it when anchored to a real composer, never
    // a fenced/indented example (whose prompt is already excluded above).
    const above = previous(top);
    if (above >= 0 && effort.test(lines[above].trim())) hidden.add(above);
    const details: string[] = [];
    let model: string | undefined = startupHeader ? lines[first + 1].replace(/^[\s▐▛▜▝▘█▗▟▄▀·]+/, '').split(/\s+·\s+/)[0] : undefined;
    for (let j = bottom + 1; j < Math.min(lines.length, bottom + 9); j++) {
      const raw = lines[j].trim();
      if (!raw) continue;
      if (effort.test(raw)) { hidden.add(j); continue; }
      if (code.has(j) || (!hud.test(raw) && !hint.test(raw))) break;
      hidden.add(j);
      const badge = hud.test(raw) ? /^\[([^\]]+)\]/.exec(raw) : null;
      if (badge) model = badge[1];
      const text = raw.slice(badge?.[0].length || 0).replace(bar, '').replace(/\s+/g, ' ').trim();
      if (text && !details.includes(text)) details.push(text);
    }
    // Last composer wins, including an empty footer after /clear or a mode
    // switch; old scrollback must not resurrect an earlier model/status.
    const directory = startupHeader ? lines[first + 2]?.replace(/^[\s▐▛▜▝▘█▗▟▄▀·]+/, '').trim() : undefined;
    const cwd = directory && /^(?:[A-Za-z]:[\\/]|\/|~[\\/]|\\\\)/.test(directory) ? directory : undefined;
    status = model || details.length || cwd ? { model, cwd, lines: details } : undefined;
  }
  return { hidden, status };
}
