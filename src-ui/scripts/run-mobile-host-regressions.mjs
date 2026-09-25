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
const projectionActive = propExpression('TierTerminal', 'conversationActive');
const context = {
  t: { id: 'phone-session', viewMode: 'terminal' }, activeTerminalId: 'other',
  diffTabActive: false, editorTabActive: true, mobileWatching: new Set(['phone-session']),
};
assert.equal(evaluate(chatActive, context), true);
assert.equal(evaluate(projectionActive, context), true);
context.mobileWatching.clear();
assert.equal(evaluate(chatActive, context), false);
assert.equal(evaluate(projectionActive, context), false);
context.activeTerminalId = 'phone-session'; context.t.viewMode = 'chat';
assert.equal(evaluate(chatActive, context), false, 'an editor tab owns desktop focus');
context.editorTabActive = false;
assert.equal(evaluate(chatActive, context), true);
context.t.viewMode = 'terminal';
assert.equal(evaluate(chatActive, context), false);
context.t.chatPending = { text: 'queued prompt' };
assert.equal(evaluate(chatActive, context), true);

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
  isTauri: true, commands: { takePendingLaunch: async () => null },
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
