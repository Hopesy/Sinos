import { Terminal } from '@xterm/xterm';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { projectConversation, type ConversationProjection } from './conversationProjection';
import { parseClaudeTerminalTitle } from '../lib/claude-terminal-title';
import { parseCodexTerminalTitle } from '../lib/codex-terminal-title';
import { parseGrokTerminalTitle } from '../lib/grok-terminal-title';
import { isTerminalRule } from './claudeChrome';

/** A VT decoder only: never open(), attach DOM, fit, or send terminal replies.
 * Cursor movement, repaint, wrapped CJK and split escape sequences are resolved
 * before any content reaches the chat UI. */
export class TerminalConversation {
  private terminal: Terminal;
  private activity: ConversationProjection['activity'];
  private tool: string | null | undefined;
  constructor(cols: number, rows: number, tool?: string | null) {
    this.tool = tool;
    this.terminal = new Terminal({ cols, rows, scrollback: 3000, allowProposedApi: true });
    this.terminal.loadAddon(new Unicode11Addon());
    this.terminal.unicode.activeVersion = '11';
    this.terminal.onTitleChange(title => {
      const parsed = tool === 'claude' ? parseClaudeTerminalTitle(title) : tool === 'codex' ? parseCodexTerminalTitle(title) : tool === 'grok' ? parseGrokTerminalTitle(title) : null;
      if (parsed) this.activity = parsed.status === 'working' ? 'working' : parsed.status === 'wait_input' ? 'waiting' : 'idle';
    });
  }
  write(data: string): Promise<ConversationProjection> {
    return new Promise(resolve => this.terminal.write(data, () => resolve(this.project())));
  }
  reset() { this.terminal.reset(); this.activity = undefined; }
  resize(cols: number, rows: number) { this.terminal.resize(cols, rows); }
  dispose() { this.terminal.dispose(); }
  private project() {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    let cursor = 0;
    let fence = '', fenceLength = 0, previousRule = false;
    for (let y = Math.max(0, buffer.length - 1000); y < buffer.length; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      const text = line.translateToString(!buffer.getLine(y + 1)?.isWrapped);
      const previous = buffer.getLine(y - 1);
      const filled = (column: number) => { const cell = previous?.getCell(column); return Boolean(cell && (cell.getChars() || cell.getWidth() === 0)); };
      // Erase-to-end during an Ink repaint leaves isWrapped on the following
      // row. A short, erased predecessor is no longer a wrapped paragraph.
      // A wide character may legitimately wrap with one unused cell left.
      const wideGap = line.isWrapped && !filled(this.terminal.cols - 1) && filled(this.terminal.cols - 2) && line.getCell(0)?.getWidth() === 2;
      const wrapped = line.isWrapped && (this.tool !== 'claude' || filled(this.terminal.cols - 1) || wideGap);
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(text)?.[1];
      const rule: boolean = this.tool === 'claude' && !fence && (isTerminalRule(text) || (previousRule && wrapped && /^[\s─━═┄┈]+$/.test(text) && /[─━═┄┈]/.test(text)));
      if (wrapped && lines.length && ((rule && previousRule) || (!rule && !previousRule))) {
        if (wideGap) lines[lines.length - 1] = lines[lines.length - 1].slice(0, -1);
        lines[lines.length - 1] += text;
      }
      else lines.push(text);
      previousRule = rule;
      if (marker && !wrapped) {
        if (!fence) { fence = marker[0]; fenceLength = marker.length; }
        else if (marker[0] === fence && marker.length >= fenceLength && text.trim() === marker) fence = '';
      }
      if (y === buffer.baseY + buffer.cursorY) cursor = lines.length - 1;
    }
    return { ...projectConversation(lines, cursor, this.tool), activity: this.activity };
  }
}
