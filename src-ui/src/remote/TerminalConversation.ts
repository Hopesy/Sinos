import { Terminal } from '@xterm/xterm';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { projectConversation, type ConversationProjection } from './conversationProjection';
import { parseClaudeTerminalTitle } from '../lib/claude-terminal-title';
import { parseCodexTerminalTitle } from '../lib/codex-terminal-title';
import { parseGrokTerminalTitle } from '../lib/grok-terminal-title';
import { parseOmpTerminalTitle } from '../lib/omp-terminal-title';
import { isTerminalRule } from './claudeChrome';

let decoderId = 0;

/** A VT decoder only: never open(), attach DOM, fit, or send terminal replies.
 * Cursor movement, repaint, wrapped CJK and split escape sequences are resolved
 * before any content reaches the chat UI. */
export class TerminalConversation {
  private terminal: Terminal;
  private activity: ConversationProjection['activity'];
  private title?: string;
  private tool: string | null | undefined;
  private status: ConversationProjection['terminalStatus'];
  private events: ConversationProjection['events'] = [];
  private nextEvent = 0;
  private prefix = `terminal-stream-${++decoderId}`;
  private pending: ((projection: ConversationProjection) => void)[] = [];
  private repaint: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  constructor(cols: number, rows: number, tool?: string | null) {
    this.tool = tool;
    this.terminal = new Terminal({ cols, rows, scrollback: 3000, allowProposedApi: true });
    this.terminal.loadAddon(new Unicode11Addon());
    this.terminal.unicode.activeVersion = '11';
    this.terminal.onTitleChange(title => {
      const parsed = tool === 'claude' ? parseClaudeTerminalTitle(title) : tool === 'codex' ? parseCodexTerminalTitle(title) : tool === 'grok' ? parseGrokTerminalTitle(title) : tool === 'omp' ? parseOmpTerminalTitle(title) : null;
      if (parsed) {
        this.activity = parsed.status === 'working' ? 'working' : parsed.status === 'wait_input' ? 'waiting' : 'idle';
        this.title = parsed.displayTitle;
      }
    });
  }
  write(data: string): Promise<ConversationProjection> {
    return new Promise(resolve => this.terminal.write(data, () => {
      if (this.disposed) { resolve({ events: [], question: null }); return; }
      this.pending.push(resolve);
      // xterm can finish many small PTY writes in one batch. Decode every
      // byte, but scan scrollback at most once per display frame.
      this.repaint ??= setTimeout(() => {
        this.repaint = undefined;
        const result = this.project();
        this.pending.splice(0).forEach(done => done(result));
      }, 16);
    }));
  }
  reset() { this.terminal.reset(); this.activity = undefined; this.title = undefined; this.status = undefined; this.events = []; }
  resize(cols: number, rows: number) { this.terminal.resize(cols, rows); }
  dispose() { this.disposed = true; clearTimeout(this.repaint); this.pending.splice(0).forEach(done => done({ events: [], question: null })); this.terminal.dispose(); }
  private project() {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    const richLines: string[] = [];
    const codeRows = new Set<number>();
    let cursor = 0;
    let fence = '', fenceLength = 0, previousRule = false;
    for (let y = Math.max(0, buffer.length - 1000); y < buffer.length; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      const text = line.translateToString(!buffer.getLine(y + 1)?.isWrapped);
      const previous = buffer.getLine(y - 1);
      const filled = (column: number) => { const cell = previous?.getCell(column); return Boolean(cell && (cell.getChars().trim() || cell.getWidth() === 0)); };
      // Erase-to-end during an Ink repaint leaves isWrapped on the following
      // row. A short, erased predecessor is no longer a wrapped paragraph.
      // A wide character may legitimately wrap with one unused cell left.
      const edge = previous?.getCell(this.terminal.cols - 1);
      const beforeEdge = filled(this.terminal.cols - 2) || (previous?.getCell(this.terminal.cols - 2)?.getChars() === ' ' && filled(this.terminal.cols - 3));
      const wideGap = line.isWrapped && edge?.getWidth() === 1 && !edge.getChars() && beforeEdge && line.getCell(0)?.getWidth() === 2;
      // ConPTY repaint pads erased rows with actual space cells, and can leave
      // isWrapped on the next row. Those spaces do not establish a soft wrap.
      // Retain a real word boundary at the edge (one trailing space), though.
      const wordGap = line.isWrapped && previous?.getCell(this.terminal.cols - 1)?.getChars() === ' ' && filled(this.terminal.cols - 2);
      const wrapped = line.isWrapped && (!['claude', 'codex'].includes(this.tool || '') || filled(this.terminal.cols - 1) || wideGap || wordGap);
      let rich = text;
      // Syntax-highlighted code in Codex has an explicit foreground on every
      // content cell. Prose has default foreground; links are underlined.
      // Do not infer code from a keyword or from one colored inline fragment.
      let styled = 0, plain = 0, underline = false;
      if (this.tool === 'codex') for (let x = 2; x < this.terminal.cols; x++) {
        const cell = line.getCell(x);
        if (!cell || !cell.getChars().trim()) continue;
        if (cell.isFgDefault()) plain++; else styled++;
        underline ||= Boolean(cell.isUnderline());
      }
      const tableRule = (value: string) => /^\s*[━─]+(?: {2,}[━─]+)+\s*$/.test(value);
      const code = styled > 0 && plain === 0 && !underline && /^(?:• | {2})/.test(text) && !tableRule(text) && !tableRule(buffer.getLine(y + 1)?.translateToString(true) || '');
      const claudeStyled = this.tool === 'claude' && Array.from({ length: this.terminal.cols }, (_, x) => line.getCell(x)).some(cell => cell && (cell.isBold() || cell.isItalic() || cell.isStrikethrough()));
      if ((this.tool === 'codex' || claudeStyled) && !fence && !/^\s*(?:• )?\s*#{1,6}\s/.test(text) && !/^ {6}/.test(text)) {
        // Preserve emphasis that the TUI has already rendered from Markdown.
        // Restrict this to semantic SGR flags; colors alone aren't reliable
        // code delimiters, and terminal text is never interpreted as HTML.
        rich = ''; let run = '', marker = '';
        const flush = () => {
          const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(run)!;
          const literal = match[2].replace(/([\\*_[\]~`<])/g, '\\$1');
          rich += match[1] + (match[2] ? marker + literal + [...marker].reverse().join('') : '') + match[3]; run = '';
        };
        for (let x = 0; x < this.terminal.cols; x++) {
          const cell = line.getCell(x);
          if (!cell || cell.getWidth() === 0) continue;
          const next = (cell.isStrikethrough() ? '~~' : '') + (cell.isBold() ? '**' : '') + (cell.isItalic() ? '_' : '');
          if (next !== marker) { flush(); marker = next; }
          run += cell.getChars() || ' ';
        }
        flush();
        if (!buffer.getLine(y + 1)?.isWrapped) rich = rich.trimEnd();
      }
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(text)?.[1];
      const rule: boolean = this.tool === 'claude' && !fence && (isTerminalRule(text) || (previousRule && wrapped && /^[\s─━═┄┈]+$/.test(text) && /[─━═┄┈]/.test(text)));
      if (wrapped && lines.length && ((rule && previousRule) || (!rule && !previousRule))) {
        if (wideGap) lines[lines.length - 1] = lines[lines.length - 1].slice(0, -1);
        lines[lines.length - 1] += text;
        if (wideGap) richLines[richLines.length - 1] = richLines[richLines.length - 1].slice(0, -1);
        richLines[richLines.length - 1] += rich;
      }
      else {
        // Once the next row proves that a wrap flag was stale, discard the
        // predecessor's repaint padding without touching real soft wraps.
        if (lines.length) {
          lines[lines.length - 1] = lines[lines.length - 1].trimEnd();
          richLines[richLines.length - 1] = richLines[richLines.length - 1].trimEnd();
        }
        lines.push(text); richLines.push(rich);
      }
      if (code) codeRows.add(lines.length - 1);
      previousRule = rule;
      if (marker && !wrapped) {
        if (!fence) { fence = marker[0]; fenceLength = marker.length; }
        else if (marker[0] === fence && marker.length >= fenceLength && text.trim() === marker) fence = '';
      }
      if (y === buffer.baseY + buffer.cursorY) cursor = lines.length - 1;
    }
    const result = projectConversation(lines, cursor, this.tool, richLines, codeRows);
    if (this.tool === 'codex' || this.tool === 'claude') {
      let position = 0;
      const plain = (text: string) => text.replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim();
      result.events = result.events.map(event => {
        const text = plain(event.text);
        const index = this.events.findIndex((previous, i) => i >= position && previous.kind === event.kind && (plain(previous.text).startsWith(text) || text.startsWith(plain(previous.text))));
        const id = index >= 0 ? this.events[index].id : `${this.prefix}-${this.nextEvent++}`;
        if (index >= 0) position = index + 1;
        return { ...event, id };
      });
      this.events = result.events;
      if (result.terminalStatus) this.status = { ...this.status, ...result.terminalStatus, model: result.terminalStatus.model || this.status?.model, lines: result.terminalStatus.lines.length ? result.terminalStatus.lines : this.status?.lines || [] };
      result.terminalStatus = this.status;
    }
    return { ...result, title: this.title, activity: this.activity };
  }
}
