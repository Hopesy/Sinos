import { describe, expect, mock, test, tier } from 'claude-code/testing';

tier('user');
describe('register', () => {
  test('uses bounded file IPC when network policy refuses loopback and ignores subagents', async ($, on) => {
    const files = [];
    mock.env(on, { SINOS_CLAUDE_BRIDGE_URL: 'http://127.0.0.1:12345/events', SINOS_CLAUDE_BRIDGE_TOKEN: 'test-token' });
    on('session.start', ($, e) => ({ cwd: e.cwd }));
    on('session.id', () => ({ value: 'session-1' }));
    on('session.model', () => ({ value: 'claude-test' }));
    on('session.cwd', () => ({ value: '/work' }));
    on('http.fetch', () => { throw new Error('nonessential network disabled'); });
    on('fs.write', ($, e) => { files.push(JSON.parse(e.text)); return { value: undefined }; });
    on('turn.start', ($, e) => ({ turnId: e.turnId }));
    on('turn.step', async function* ($, e) { yield { kind: 'text', index: 0, text: e.agentId ? 'child-secret' : 'main answer' }; return { turnId: e.turnId, index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }; });
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' });
    await $.turn.start({ turnId: 't1', text: 'hello' });
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'test', messageCount: 1 })) { /* drain */ }
    const count = files.length;
    for await (const _ of $.turn.step({ turnId: 'child', index: 0, model: 'test', messageCount: 1, agentId: 'agent-1' })) { /* drain */ }
    expect(files.length).toBe(count);
    const latest = files.at(-1);
    expect(latest.map(packet => packet.sequence)).toEqual(latest.map((_, index) => index + 1));
    expect(JSON.stringify(latest)).toContain('main answer');
    expect(JSON.stringify(latest)).not.toContain('child-secret');
  });
  test('mirrors visible text and thinking without changing chunks or exposing signatures', async ($, on) => {
    const sent = [];
    mock.env(on, { SINOS_CLAUDE_BRIDGE_URL: 'http://127.0.0.1:12345/events', SINOS_CLAUDE_BRIDGE_TOKEN: 'test-token' });
    on('session.start', ($, e) => ({ cwd: e.cwd }));
    on('session.id', () => ({ value: 'session-1' }));
    on('session.model', () => ({ value: 'claude-test' }));
    on('session.cwd', () => ({ value: '/work' }));
    on('session.usage', () => ({ value: { context: { percent: 7 }, rateLimits: [], cost: {} } }));
    on('http.fetch', ($, e) => { sent.push(...JSON.parse(e.init.body).events); return { value: { status: 200, ok: true, headers: {}, text: '' } }; });
    on('turn.start', ($, e) => ({ turnId: e.turnId }));
    const chunks = [{ kind: 'text', index: 0, text: '1. **First**\n' }, { kind: 'thinking', index: 1, text: 'Visible model thinking', signature: 'private-signature' }, { kind: 'text', index: 2, text: '2. Second\n' }];
    const result = { turnId: 't1', index: 0, answer: '1. **First**\n2. Second\n', toolUses: [], stopReason: 'end_turn', usage: null };
    on('turn.step', async function* () { for (const chunk of chunks) yield chunk; return result; });
    on('turn.complete', ($, e) => ({ text: e.answer }));
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' });
    await $.turn.start({ text: 'hello', turnId: 't1' });
    const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-test', messageCount: 1 });
    const received = []; let returned;
    for (;;) { const item = await stream.next(); if (item.done) { returned = item.value; break; } received.push(item.value); }
    expect(received).toEqual(chunks);
    expect(returned).toEqual(result);
    await $.turn.complete({ turnId: 't1', answer: result.answer, durationMs: 1, isAborted: false, reason: 'answer' });
    expect(sent.filter(e => e.kind === 'text').map(e => e.text)).toEqual(['1. **First**\n', '2. Second\n']);
    expect(JSON.stringify(sent)).not.toContain('private');
    expect(sent.filter(e => e.kind === 'thinking').map(e => e.text)).toEqual(['Visible model thinking']);
    expect(sent.some(e => e.kind === 'complete')).toBe(true);
  });
});
