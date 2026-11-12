import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
const parse = file => ts.createSourceFile(file, readFileSync(`src/${file}`, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(source, match) { let result; function visit(node) { if (match(node)) result = node; ts.forEachChild(node, visit); } visit(source); assert.ok(result); return result; }
const effect = file => { const source = parse(file); return find(source, n => ts.isCallExpression(n) && n.expression.getText(source) === 'useEffect' && n.arguments[0]?.getText(source).includes("addEventListener('keydown'")).arguments[0].getText(source); };
const js = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
let failed = 0;
for (const kind of ['claude', 'codex', 'dsh', 'opencode', 'pi', 'permission']) {
  try {
    const dom = new JSDOM('<button id="outside">Workspace</button><div role="dialog" aria-modal="true"><button id="setting">Setting</button></div>');
    let actions = 0;
    const context = { window: dom.window, document: dom.window.document, Element: dom.window.Element, isActive: true, s: { busy: true, requests: [] }, sessionId: 'tab', keyboardEnabled: true, submitting: false, interaction: { options: [{ position: 0, number: 1 }] }, keyboardPosition: 0, selectOption: () => actions++, setFailed() {}, setKeyboardPosition() {}, controlClaude: async () => actions++, interruptCodex: async () => actions++, stopDsh: async () => actions++, interruptOpenCode: async () => actions++, abortPi: async () => actions++ };
    if (existsSync('src/lib/session-keyboard.ts')) {
      const module = { exports: {} }; runInNewContext(js(readFileSync('src/lib/session-keyboard.ts', 'utf8')), { ...context, module, exports: module.exports }); Object.assign(context, module.exports);
    }
    const file = kind === 'permission' ? 'TerminalInteractionCard' : `${kind === 'dsh' ? 'Dsh' : kind === 'opencode' ? 'OpenCode' : kind[0].toUpperCase() + kind.slice(1)}Conversation`;
    const cleanup = runInNewContext(js(`(${effect(`components/center/${file}.tsx`)})()`), context);
    const key = kind === 'permission' ? 'Enter' : 'Escape';
    const fire = (id, extra = {}) => dom.window.document.getElementById(id).dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
    fire('setting'); assert.equal(actions, 0, 'dialog buttons own their keyboard events');
    fire('outside'); assert.equal(actions, 0, 'opening a modal also covers focus left in the workspace');
    dom.window.document.querySelector('[role="dialog"]').remove();
    fire('outside', { isComposing: true }); assert.equal(actions, 0, 'IME cancellation stays local');
    const consumed = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    consumed.preventDefault(); dom.window.document.getElementById('outside').dispatchEvent(consumed);
    assert.equal(actions, 0, 'consumed events stay local, including capture listeners');
    fire('outside'); assert.equal(actions, 1, 'normal conversation shortcuts remain available');
    cleanup?.(); dom.window.close(); console.log('OK: modal ownership, composition and ordinary shortcut', kind);
  } catch (error) { failed++; console.error('FAIL:', kind, error); }
}
try {
  const dom = new JSDOM('<button id="setting">Setting</button>'); let closed = 0, leaked = 0;
  const cleanup = runInNewContext(js(`(${effect('components/common/SettingsModal.tsx')})()`), { open: true, document: dom.window.document, close: () => closed++ });
  dom.window.addEventListener('keydown', () => leaked++);
  const button = dom.window.document.getElementById('setting');
  button.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true }));
  assert.equal(closed, 0); leaked = 0;
  const escape = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  button.dispatchEvent(escape);
  assert.equal(closed, 1); assert.equal(leaked, 0); assert.equal(escape.defaultPrevented, true);
  cleanup(); dom.window.close(); console.log('OK: Settings Escape closes locally and preserves IME composition');
} catch (error) { failed++; console.error('FAIL: Settings Escape', error); }
try {
  const source = parse('components/center/CenterPanel.tsx');
  for (const component of ['ClaudeConversation', 'CodexConversation', 'DshConversation', 'OpenCodeConversation', 'PiConversation', 'TierTerminal', 'ConversationView']) {
    const node = find(source, n => (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && n.tagName.getText(source) === component);
    const evaluate = (prop, settingsOpen) => {
      const expression = node.attributes.properties.find(p => p.name?.getText(source) === prop)?.initializer?.expression;
      assert.ok(expression, `${component}.${prop}`);
      return runInNewContext(expression.getText(source), { t: { id: 'tab', viewMode: component === 'ConversationView' ? 'chat' : 'terminal' }, activeTerminalId: 'tab', contentActive: true, splitVisible: false, splitIds: [], mobileWatching: new Set(), state: { settingsOpen } });
    };
    const focus = component === 'ConversationView' ? 'isFocused' : 'isActive';
    assert.equal(evaluate(focus, true), false, `${component}: modal owns keyboard`);
    assert.equal(evaluate(focus, false), true, `${component}: keyboard returns after closing`);
    assert.equal(evaluate('isVisible', true), true, `${component}: background content stays visible`);
  }
  console.log('OK: Settings releases native and PTY focus while preserving visible panes');
} catch (error) { failed++; console.error('FAIL: CenterPanel focus ownership', error); }
if (failed) process.exitCode = 1;
