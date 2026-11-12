/** Exercise hidden/revealed viewport changes using the actual virtualizer hook. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const file = new URL('../src/components/center/conversation-virtualizer.ts', import.meta.url);
const source = ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
const code = source.statements.filter(node => !ts.isImportDeclaration(node))
  .map(node => node.getText(source).replace(/^export /, '')).join('\n');
const frames = [];
const state = [];
const listeners = new Map();
const scroll = {
  scrollTop: 5000, clientHeight: 600,
  addEventListener: (name, listener) => listeners.set(name, listener),
  removeEventListener: name => listeners.delete(name),
};
const messages = Array.from({ length: 100 }, (_, i) => ({ id: String(i), role: 'user', content: `Message ${i}` }));
let resize;
const virtualizer = runInNewContext(ts.transpileModule(`${code}; useConversationVirtualizer(messages, {current: scroll});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, {
  messages, scroll,
  useRef: current => ({ current }),
  useCallback: callback => callback,
  useMemo: factory => factory(),
  useState: initial => {
    const index = state.length;
    state.push(typeof initial === 'function' ? initial() : initial);
    return [state[index], update => { state[index] = typeof update === 'function' ? update(state[index]) : update; }];
  },
  useEffect: effect => effect(),
  useLayoutEffect: effect => effect(),
  useInsertionEffect: effect => effect(),
  ResizeObserver: class {
    constructor(callback) { resize = callback; }
    observe() {}
    disconnect() {}
  },
  window: {
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    cancelAnimationFrame() {},
  },
});
const flush = () => { while (frames.length) frames.shift()(); };
flush();
const visibleRange = state[1];
assert.ok(visibleRange.start > 0 && visibleRange.end > visibleRange.start);
scroll.clientHeight = 0;
scroll.scrollTop = 0;
resize(); flush();
assert.equal(state[1], visibleRange, 'hiding a tab preserves its rendered message range');
scroll.clientHeight = 600;
scroll.scrollTop = 5000;
resize(); flush();
assert.equal(state[1], visibleRange, 'revealing at the same position does not rebuild the rows');
scroll.scrollTop = 6000;
listeners.get('scroll')(); flush();
assert.ok(state[1].start > visibleRange.start, 'visible scrolling still updates the message range');
console.log('OK: hidden conversation range, reveal reuse, and visible scrolling');
virtualizer.measureRow(virtualizer.measurementKeys[0], 123);
virtualizer.measureRow('expired-message-revision', 456);
flush();
assert.equal(state[0].size, 1, 'the measurement frame rejects callbacks from obsolete rows');
assert.equal(state[0].get(virtualizer.measurementKeys[0]), 123, 'the current row measurement is retained');

const prune = runInNewContext(ts.transpileModule(`${code}; pruneMeasurements;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText);
let heights = new Map([['history', 120]]);
for (let revision = 0; revision < 10000; revision++) {
  heights.set(`live-${revision}`, 200 + revision);
  heights = prune(heights, new Set(['history', `live-${revision}`]));
  assert.equal(heights.size, 2, 'streaming revisions do not accumulate measurements');
  assert.equal(heights.get('history'), 120, 'unchanged history retains its measured height');
}
assert.equal(prune(heights, new Set()).size, 0, 'replaced transcripts release old measurements');
assert.equal(prune(heights, new Set(heights.keys())), heights, 'unchanged keys reuse their cache');
console.log('OK: streaming measurement retention stays bounded across 10,000 revisions');
