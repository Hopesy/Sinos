import { pairIdFromPublicKey } from './pairing';
import { PairRoom } from './room';

export { PairRoom };

export interface Env {
  PAIR_ROOM: DurableObjectNamespace<PairRoom>;
  /** 静态资源（手机 PWA）：非 /v1 路径回落到这里 */
  ASSETS: Fetcher;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** 由 host 公钥算 pairId，把请求（带解析后的 body）转给对应 DO */
async function routeByPublicKey(
  request: Request,
  env: Env,
  internalPath: string
): Promise<Response> {
  let body: { publicKey?: unknown };
  try {
    const reader = request.body?.getReader();
    if (!reader) return json({ error: 'missing body' }, 400);
    const parts: Uint8Array[] = []; let size = 0;
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.length;
      if (size > 4096) { await reader.cancel(); return json({ error: 'body too large' }, 413); }
      parts.push(chunk.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    body = JSON.parse(new TextDecoder().decode(bytes)) as { publicKey?: unknown };
    if (!body || typeof body !== 'object') return json({ error: 'invalid body' }, 400);
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  if (typeof body.publicKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.publicKey)) {
    return json({ error: 'missing publicKey' }, 400);
  }
  const pairId = await pairIdFromPublicKey(body.publicKey);
  const stub = env.PAIR_ROOM.get(env.PAIR_ROOM.idFromName(pairId));
  return stub.fetch(`https://do${internalPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pair-id': pairId },
    body: JSON.stringify(body),
  });
}

/** :id 直接就是 pairId（重连 / 解绑，两端已持有）；转给 DO，保留 method/headers（含 WSS Upgrade） */
function routeById(
  request: Request,
  env: Env,
  pairId: string,
  internalPath: string
): Promise<Response> {
  const stub = env.PAIR_ROOM.get(env.PAIR_ROOM.idFromName(pairId));
  const url = new URL(request.url);
  return stub.fetch(new Request(`https://do${internalPath}${url.search}`, request));
}

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/v1/health') return json({ ok: true, protocol: 'coffee-v1' });
  if (Number(request.headers.get('content-length') || 0) > 4096) return json({ error: 'body too large' }, 413);

  if (path === '/v1/pair/request' && request.method === 'POST') {
    return routeByPublicKey(request, env, '/request');
  }
  if (path === '/v1/pair/claim' && request.method === 'POST') {
    return routeByPublicKey(request, env, '/claim');
  }
  if (path === '/v1/pair/cancel' && request.method === 'POST') {
    return routeByPublicKey(request, env, '/cancel');
  }

  // /v1/pair/:id  (WSS 连接 或 DELETE 解绑)
  const m = /^\/v1\/pair\/([^/]+)$/.exec(path);
  if (m) {
    const pairId = m[1];
    if (!/^[A-Za-z0-9_-]{22}$/.test(pairId)) return json({ error: 'invalid pair id' }, 400);
    if (request.headers.get('Upgrade') === 'websocket') {
      return routeById(request, env, pairId, '/connect');
    }
    if (request.method === 'DELETE') {
      return routeById(request, env, pairId, '/delete');
    }
  }

  if (path.startsWith('/v1/')) return json({ error: 'not found' }, 404);
  // 非 /v1 路径交给静态资源（手机 PWA 与中继同域部署）
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    let res: Response;
    try { res = await route(request, env); }
    catch { return json({ error: 'invalid request' }, 400); }
    // WSS upgrade（101 + webSocket）不可改写，直接返回
    if (res.webSocket) return res;
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
    return out;
  },
};
