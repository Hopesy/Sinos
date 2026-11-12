import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const parse = file => ts.createSourceFile(file,
  readFileSync(new URL(`../src/components/center/${file}`, import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const evaluate = (code, context) => runInNewContext(ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText, context);

// Exercise the actual lazy conversation owner: a phone must activate an unseen
// desktop conversation, and hiding it must retain the same content/scroll owner.
const conversation = parse('ConversationView.tsx');
const owner = conversation.statements.find(node =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'ConversationViewImpl');
assert.ok(owner);
let opened, writes = 0;
const render = evaluate(`${owner.getText(conversation)}; ConversationViewImpl`, {
  useState: initial => {
    opened ??= initial;
    return [opened, value => { opened = value; writes++; }];
  },
  React: { createElement: (type, props) => ({ type, props }) },
  ConversationContent: 'conversation-content',
});
assert.equal(render({ isActive: false, isVisible: false }), null);
const mobile = render({ isActive: true, isVisible: false });
assert.equal(mobile.type, 'conversation-content');
assert.equal(writes, 1);
assert.equal(render({ isActive: false, isVisible: false }).type, mobile.type);
assert.equal(render({ isActive: true, isVisible: true }).type, mobile.type);
assert.equal(writes, 1, 'a mode switch must retain the mounted owner');

// Evaluate the real CenterPanel props with desktop focus, editor tabs and phone
// subscriptions. This catches automatic merges that drop mobileWatching.
const center = parse('CenterPanel.tsx');
function propExpression(component, attribute) {
  let result;
  function visit(node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(center) === component) {
      const attrs = node.attributes.properties;
      if (attrs.some(a => a.name?.getText(center) === 'sessionId'
        && a.initializer?.expression?.getText(center) === 't.id')) {
        result = attrs.find(a => a.name?.getText(center) === attribute)?.initializer?.expression;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(center);
  assert.ok(result, `${component}.${attribute}`);
  return result.getText(center);
}
const chatActive = propExpression('ConversationView', 'isActive');
const chatFocused = propExpression('ConversationView', 'isFocused');
const projectionActive = propExpression('TierTerminal', 'conversationActive');
const context = {
  state: { settingsOpen: false },
  t: { id: 'phone-session', viewMode: 'terminal' }, activeTerminalId: 'other',
  diffTabActive: false, editorTabActive: true, contentActive: false, splitVisible: false, splitIds: [], mobileWatching: new Set(['phone-session']),
};
assert.equal(evaluate(chatActive, context), true);
assert.equal(evaluate(projectionActive, context), true);
context.mobileWatching.clear();
assert.equal(evaluate(chatActive, context), false);
assert.equal(evaluate(projectionActive, context), false);
context.activeTerminalId = 'phone-session'; context.t.viewMode = 'chat';
assert.equal(evaluate(chatActive, context), false, 'an editor tab owns desktop focus');
context.editorTabActive = false; context.contentActive = true;
assert.equal(evaluate(chatActive, context), true);
context.t.viewMode = 'terminal';
assert.equal(evaluate(chatActive, context), false);
context.t.chatPending = { text: 'queued prompt' };
assert.equal(evaluate(chatActive, context), true);
context.t.chatPending = undefined;
context.t.viewMode = 'chat'; context.activeTerminalId = 'other';
context.splitVisible = true; context.splitIds = ['other', 'phone-session'];
assert.equal(evaluate(chatActive, context), true, 'a visible unfocused split transcript continues reading');
assert.equal(evaluate(chatFocused, context), false, 'the other split cannot consume focused keyboard input');
let interactionKeyboard;
function findKeyboard(node) {
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(conversation) === 'TerminalInteractionCard') {
    interactionKeyboard = node.attributes.properties.find(attribute => attribute.name?.getText(conversation) === 'keyboardEnabled')?.initializer?.expression?.getText(conversation);
  }
  ts.forEachChild(node, findKeyboard);
}
findKeyboard(conversation); assert.ok(interactionKeyboard);
assert.equal(evaluate(interactionKeyboard, { isActive: true, isVisible: true, isFocused: false }), false, 'reading another visible pane does not answer its permission prompt');
assert.equal(evaluate(projectionActive, context), true, 'its terminal projection remains active');
context.contentActive = false; context.splitVisible = false;
assert.equal(evaluate(chatActive, context), false, 'utility pages suspend covered desktop transcripts');
context.mobileWatching.add('phone-session');
assert.equal(evaluate(chatActive, context), true, 'phone subscribers keep covered transcripts alive');

// The late-listener fix must retain the ID reserved by a phone launch.
let effect;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(center) === 'useEffect'
    && node.arguments[0].getText(center).includes("'launch-request'")) effect = node.arguments[0];
  ts.forEachChild(node, visit);
}
visit(center); assert.ok(effect);
let listener, removed = 0; const launches = [];
const cleanup = evaluate(`(${effect.getText(center).replace("import('@tauri-apps/api/event')", 'Promise.resolve(eventModule)')})()`, {
  coldLaunchRef: { current: null }, isTauri: true, commands: { takePendingLaunch: async () => null },
  eventModule: { listen: async (_name, callback) => { listener = callback; return () => removed++; } },
  applyLaunchRequest: (...args) => launches.push(args),
});
await new Promise(resolve => setImmediate(resolve));
listener({ payload: { tool: 'claude', cwd: '/workspace', sessionId: 'reserved-mobile-id' } });
assert.deepEqual(launches, [['claude', '/workspace', 'reserved-mobile-id']]);
cleanup();
listener({ payload: { tool: 'claude', sessionId: 'after-close' } });
assert.equal(launches.length, 1);
assert.equal(removed, 1);
console.log('OK: hidden phone subscriptions, retained chat owner, editor focus and mobile launch identity');

let launchCallback;
function findLaunch(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(center) === 'applyLaunchRequest') launchCallback = node.initializer;
  ts.forEachChild(node, findLaunch);
}
findLaunch(center); assert.ok(launchCallback);
const actions = [];
const phoneTools = ['claude', 'codex', 'opencode', 'pi'];
const reducerTree = ts.createSourceFile('app-state.tsx', readFileSync(new URL('../src/store/app-state.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const reducerNode = reducerTree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'reducer');
assert.ok(reducerNode);
const reduce = evaluate(`${reducerNode.getText(reducerTree)}; reducer`, {});
const launch = evaluate(`const launch = ${launchCallback.getText(center)}; launch`, {
  BUILTIN_AI_CLI_FALLBACK: phoneTools.map(key => ({ key })),
  launchCtxRef: { current: { terminals: [{ id: 'busy', tool: 'claude' }], activeTerminalId: 'busy' } },
  dispatch: action => actions.push(action), pushRecentFolder() {}, rememberFolder() {},
});
for (const tool of phoneTools) {
  actions.length = 0;
  launch(tool, '/workspace', `phone-${tool}`);
  const added = actions.find(action => action.type === 'ADD_TERMINAL').session;
  assert.equal(added.id, `phone-${tool}`);
  const start = actions.find(action => action.type === 'SET_TERMINAL_TOOL');
  assert.equal(start.id, `phone-${tool}`);
  if (tool === 'claude' || tool === 'codex') assert.equal(start[`${tool}Mode`], 'terminal');
  const launched = reduce({ terminals: [added] }, start).terminals[0];
  assert.equal(launched[`${tool}Mode`], 'terminal', `${tool}: phone launch retains the shared PTY even when desktop conversations are supported`);
}
console.log('OK: phone Claude/Codex/OpenCode/Pi launches preserve the reserved ID and shared PTY transport');
