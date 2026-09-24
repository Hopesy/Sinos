export interface TerminalStatus { model?: string; lines: string[] }

// Ink's composer rules occupy a whole terminal row. A stale VT wrap flag
// must not glue one to the prompt/HUD and turn it into a long chat paragraph.
export const isTerminalRule = (line: string) => /^[\s─━═┄┈]{8,}$/.test(line) && /[─━═┄┈]/.test(line);
const prompt = /^\s*[❯›>]\s*$/;
const hud = /^\s*\[[^\]\n]{1,80}\](?:\s|$)/;
const hint = /^(?:[⏸⏵▶▸]\s*)?(?:manual mode on|accept edits on|bypass permissions on|plan mode on|\? for shortcuts|esc to interrupt|ctrl\+c to interrupt|shift\+tab\b|.*[←→].*for agents)|^◈.*\/effort|^\d[\d,.kKmM]*\s+tokens\b/i;
const bar = /[░▒▓█▏▎▍▌▋▊▉▰▱━─]{3,}/g;

/** Only the area below a bordered, empty CLI composer is status chrome.
 * Keep code samples and similarly worded assistant output in the timeline. */
export function claudeChrome(lines: string[], code: Set<number>) {
  const hidden = new Set<number>();
  let status: TerminalStatus | undefined;
  const previous = (from: number) => { let i = from - 1; while (i >= 0 && !lines[i].trim()) i--; return i; };
  const next = (from: number) => { let i = from + 1; while (i < lines.length && !lines[i].trim()) i++; return i; };
  for (let i = 0; i < lines.length; i++) {
    if (!code.has(i) && /[▐▛▜▝▘█].*Claude Code\s+v\d/.test(lines[i]) && lines.slice(i + 1, i + 3).every(line => /[▐▛▜▝▘█]/.test(line))) {
      hidden.add(i); hidden.add(i + 1); hidden.add(i + 2);
    }
    if (code.has(i) || !prompt.test(lines[i])) continue;
    const top = previous(i), bottom = next(i);
    if (top < 0 || bottom >= lines.length || !isTerminalRule(lines[top]) || !isTerminalRule(lines[bottom])) continue;
    hidden.add(i); hidden.add(top); hidden.add(bottom);
    const details: string[] = [];
    let model: string | undefined;
    for (let j = bottom + 1; j < Math.min(lines.length, bottom + 9); j++) {
      const raw = lines[j].trim();
      if (!raw) continue;
      if (code.has(j) || (!hud.test(raw) && !hint.test(raw))) break;
      hidden.add(j);
      const badge = hud.test(raw) ? /^\[([^\]]+)\]/.exec(raw) : null;
      if (badge) model = badge[1];
      const text = raw.slice(badge?.[0].length || 0).replace(bar, '').replace(/\s+/g, ' ').trim();
      if (text && !details.includes(text)) details.push(text);
    }
    // Last composer wins, including an empty footer after /clear or a mode
    // switch; old scrollback must not resurrect an earlier model/status.
    status = model || details.length ? { model, lines: details } : undefined;
  }
  return { hidden, status };
}
