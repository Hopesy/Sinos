// Claude Code function hooks (official 2.1.277+ early-access contract).
// Always yield the exact engine chunks and return the exact downstream result.
// Never read credentials, mutate prompts, invoke tools, or answer permissions.
export function register(on) {
  let endpoint = '', token = '', turn = '', pending = [], failed = false, fileMode = false, sequence = 0;
  const archive = [];
  const packet = () => {
    const number = ++sequence;
    let body = JSON.stringify({ sequence: number, events: pending });
    // An exceptional huge block invalidates the mirror explicitly. Native
    // transcript/VT fallback can then show it without silently losing data.
    if (body.length > 30000) { body = JSON.stringify({ sequence: number, events: [{ kind: 'gap' }] }); failed = true; }
    pending = [];
    archive.push(body);
    while (archive.length > 64 || archive.join(',').length > 60000) archive.shift();
    return { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body };
  };
  const fileBody = () => `[${archive.join(',')}]`;
  on('session.end', async ($, e, next) => {
    const result = await next(e);
    if (endpoint && (e.reason === 'clear' || e.reason === 'resume')) {
      pending = [{ kind: 'end', session: e.sessionId, reason: e.reason }];
      const request = packet();
      try { if (fileMode || !(await $.http.fetch(endpoint, request)).ok) fileMode = true; } catch { fileMode = true; }
      if (fileMode) try { await $.fs.write(`${$.plugin.root}/events.json`, fileBody()); } catch { failed = true; }
    }
    return result;
  });
  on('command.run', async ($, e, next) => {
    const result = await next(e);
    if (endpoint && ['model', 'effort', 'cd', 'clear', 'resume', 'rewind', 'compact'].includes(e.command)) {
      try {
        if (e.command === 'rewind' || e.command === 'compact') pending.push({ kind: 'gap' });
        pending.push({ kind: 'session', session: await $.session.id(), model: await $.session.model(), cwd: await $.session.cwd() });
        const request = packet();
        try { if (fileMode || !(await $.http.fetch(endpoint, request)).ok) fileMode = true; } catch { fileMode = true; }
        if (fileMode) await $.fs.write(`${$.plugin.root}/events.json`, fileBody());
      } catch { failed = true; }
    }
    return result;
  });
  on('session.start', async ($, e, next) => {
    const result = await next(e);
    try {
      endpoint = await $.env.get('SINOS_CLAUDE_BRIDGE_URL') || '';
      token = await $.env.get('SINOS_CLAUDE_BRIDGE_TOKEN') || '';
      if (!/^http:\/\/127\.0\.0\.1:\d+\/events$/.test(endpoint) || !token) return result;
      pending.push({ kind: 'session', session: await $.session.id(), model: await $.session.model(), cwd: await $.session.cwd() });
      const request = packet();
      try { if (fileMode || !(await $.http.fetch(endpoint, request)).ok) fileMode = true; } catch { fileMode = true; }
      if (fileMode) await $.fs.write(`${$.plugin.root}/events.json`, fileBody());
    } catch { failed = true; }
    return result;
  });
  on('turn.start', async ($, e, next) => {
    const result = await next(e);
    if (!endpoint) return result;
    failed = false;
    turn = e.turnId;
    try {
      pending.push({ kind: 'session', session: await $.session.id(), model: await $.session.model(), cwd: await $.session.cwd() });
      pending.push({ kind: 'start', turn, text: e.text });
      const request = packet();
      try { if (fileMode || !(await $.http.fetch(endpoint, request)).ok) fileMode = true; } catch { fileMode = true; }
      if (fileMode) await $.fs.write(`${$.plugin.root}/events.json`, fileBody());
    } catch { failed = true; }
    return result;
  });
  on('turn.step', async function* ($, e, next) {
    const stream = next(e);
    let first = true;
    let result;
    try { for (;;) {
      const item = await stream.next();
      if (item.done) { result = item.value; break; }
      const chunk = item.value;
      if (!e.agentId && endpoint && !failed) {
        // Opaque engine envelopes and signed/private thinking are not relayed.
        const base = { turn: e.turnId, step: e.index, model: e.model };
        if (chunk.kind === 'text') pending.push({ ...base, kind: 'text', index: chunk.index, text: chunk.text });
        if (chunk.kind === 'tool') pending.push({ ...base, kind: 'tool', index: chunk.index, id: chunk.id, name: chunk.name });
        if (chunk.kind === 'input') pending.push({ ...base, kind: 'input', index: chunk.index, text: chunk.json });
        if (pending.length && (first || pending.length >= 4 || chunk.kind === 'stop')) {
          const request = packet();
          try { if (fileMode || !(await $.http.fetch(endpoint, request)).ok) fileMode = true; } catch { fileMode = true; }
          if (fileMode) try { await $.fs.write(`${$.plugin.root}/events.json`, fileBody()); } catch { failed = true; }
          first = false;
        }
      }
      yield chunk;
    } } finally { await stream.return(); }
    if (!e.agentId && endpoint && !failed) {
      pending.push({ kind: 'step', turn: e.turnId, step: e.index, model: e.model });
      const request = packet();
      try { if (fileMode || !(await $.http.fetch(endpoint, request)).ok) fileMode = true; } catch { fileMode = true; }
      if (fileMode) try { await $.fs.write(`${$.plugin.root}/events.json`, fileBody()); } catch { failed = true; }
    }
    return result;
  });
  on('tool.call', async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId && endpoint && !failed && e.tool_use_id) {
      pending.push({ kind: 'result', turn, id: e.tool_use_id, text: result.text || result.deny || '', failed: Boolean(result.isError || result.deny) });
      const request = packet();
      try { if (fileMode || !(await $.http.fetch(endpoint, request)).ok) fileMode = true; } catch { fileMode = true; }
      if (fileMode) try { await $.fs.write(`${$.plugin.root}/events.json`, fileBody()); } catch { failed = true; }
    }
    return result;
  });
  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId && endpoint && !failed) {
      pending.push({ kind: 'complete', turn: e.turnId, reason: e.reason });
      const request = packet();
      try { if (fileMode || !(await $.http.fetch(endpoint, request)).ok) fileMode = true; } catch { fileMode = true; }
      if (fileMode) try { await $.fs.write(`${$.plugin.root}/events.json`, fileBody()); } catch { failed = true; }
      try {
        const usage = await $.session.usage();
        pending.push({ kind: 'session', session: await $.session.id(), model: await $.session.model(), cwd: await $.session.cwd(), percent: usage.context.percent });
        const request = packet();
        try { if (fileMode || !(await $.http.fetch(endpoint, request)).ok) fileMode = true; } catch { fileMode = true; }
        if (fileMode) await $.fs.write(`${$.plugin.root}/events.json`, fileBody());
      } catch { /* Older contracts may not expose status; keep the VT footer. */ }
    }
    return result;
  });
}
