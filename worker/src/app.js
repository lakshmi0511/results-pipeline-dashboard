// Request routing for the dashboard Worker. index.js wires in page.html;
// tests call createApp() directly with a fake KV namespace.
import { renderPage } from './render.js';
import {
  bearer, MAX_PAYLOAD_BYTES, nonce, securityHeaders, timingSafeEqual, validatePayload, verifyAccessJwt,
} from './lib.js';

const DEFAULT_CONTROL = { mode: 'paused', requested_at: null, requested_by: null };
const ACTIONS = new Set(['update', 'start', 'pause']);

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: securityHeaders({ 'content-type': 'application/json' }) });
const text = (body, status) =>
  new Response(body, { status, headers: securityHeaders({ 'content-type': 'text/plain; charset=utf-8' }) });

async function getControl(env) {
  return { ...DEFAULT_CONTROL, ...((await env.DASH_KV.get('control', 'json')) || {}) };
}

/**
 * Local-development bypass for Cloudflare Access.
 * Only active when BOTH are true:
 *   - ALLOW_DEV is exactly "1" (passed by `npm run dev` on the command line;
 *     never put it in wrangler.toml [vars] and never set it as a secret), and
 *   - the request is addressed to localhost / 127.0.0.1, which a deployed
 *     Worker never sees because Cloudflare routes by your real hostname.
 */
export function devBypass(env, url) {
  return env.ALLOW_DEV === '1' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

async function requireAccess(request, env, url, fetchImpl) {
  if (devBypass(env, url)) return { email: 'local-dev@localhost', dev: true };
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return null;
  try {
    return await verifyAccessJwt(token, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD, fetchImpl });
  } catch {
    return null;
  }
}

async function checkIngestToken(request, env) {
  const expected = env.INGEST_TOKEN || '';
  if (expected.length < 32) return 'server has no INGEST_TOKEN (or it is shorter than 32 chars)';
  return (await timingSafeEqual(bearer(request), expected)) ? null : 'unauthorized';
}

export function createApp(PAGE, { fetchImpl } = {}) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const { pathname } = url;
      const method = request.method;
      const doFetch = fetchImpl || fetch;

      // ---- collector endpoints: bearer token, no Access (it is a machine) ----
      if (pathname === '/api/ingest') {
        const err = await checkIngestToken(request, env);
        if (err) return text(err, err === 'unauthorized' ? 401 : 503);
        if (method === 'GET') return json(await getControl(env));
        if (method !== 'POST') return text('method not allowed', 405);
        if (!(request.headers.get('content-type') || '').startsWith('application/json')) return text('expected application/json', 415);
        const declared = Number(request.headers.get('content-length') || 0);
        if (declared > MAX_PAYLOAD_BYTES) return text('payload too large', 413);
        const body = await request.text();
        if (body.length > MAX_PAYLOAD_BYTES) return text('payload too large', 413);
        let data;
        try { data = JSON.parse(body); } catch { return text('invalid JSON', 400); }
        const problem = validatePayload(data);
        if (problem) return text(`invalid payload: ${problem}`, 422);
        await env.DASH_KV.put('latest', body);
        await env.DASH_KV.put('latest_meta', JSON.stringify({ built_at: data.built_at, status: data.status?.overall ?? null }));
        return json({ ok: true, built_at: data.built_at, courses: data.courses.length });
      }

      // ---- everything else: verified Cloudflare Access identity required ----
      const who = await requireAccess(request, env, url, doFetch);
      if (!who) return text('Cloudflare Access sign-in required', 403);

      if (pathname === '/' && (method === 'GET' || method === 'HEAD')) {
        const [data, control] = await Promise.all([env.DASH_KV.get('latest', 'json'), getControl(env)]);
        const n = nonce();
        const html = renderPage(PAGE, data, { nonce: n, control });
        return new Response(method === 'HEAD' ? null : html, {
          headers: securityHeaders({ 'content-type': 'text/html; charset=utf-8' }, n),
        });
      }

      if (pathname === '/api/meta' && method === 'GET') {
        const [meta, control] = await Promise.all([env.DASH_KV.get('latest_meta', 'json'), getControl(env)]);
        return json({ built_at: meta?.built_at ?? null, status: meta?.status ?? null, control });
      }

      if (pathname === '/api/control') {
        if (method !== 'POST') return text('method not allowed', 405);
        // A JSON content type cannot be sent by a plain cross-site <form>, and a
        // cross-site fetch with it needs a CORS preflight we never answer.
        if (!(request.headers.get('content-type') || '').startsWith('application/json')) return text('expected application/json', 415);
        const origin = request.headers.get('origin');
        if (origin && origin !== url.origin) return text('cross-origin request refused', 403);
        const body = await request.text();
        if (body.length > 1024) return text('payload too large', 413);
        let action;
        try { ({ action } = JSON.parse(body)); } catch { return text('invalid JSON', 400); }
        if (!ACTIONS.has(action)) return text('action must be update, start or pause', 400);
        const control = await getControl(env);
        const at = new Date().toISOString();
        const by = String(who.email || who.sub || 'unknown').slice(0, 200);
        if (action === 'pause') control.mode = 'paused';
        else {
          if (action === 'start') control.mode = 'auto';
          control.requested_at = at; // "start" also triggers an immediate read
          control.requested_by = by;
        }
        control.changed_at = at;
        control.changed_by = by;
        await env.DASH_KV.put('control', JSON.stringify(control));
        return json(control);
      }

      return text('not found', 404);
    },
  };
}
