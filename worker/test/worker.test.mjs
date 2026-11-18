// Unit-ish tests for the Worker: run with `npm test` (node --test), no wrangler needed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { webcrypto } from 'node:crypto';

globalThis.crypto ??= webcrypto; // Node 18

const { createApp, devBypass } = await import('../src/app.js');
const { renderPage, safeJson } = await import('../src/render.js');
const { timingSafeEqual, verifyAccessJwt, validatePayload, resetCertCache } = await import('../src/lib.js');

const PAGE = await readFile(new URL('../src/page.html', import.meta.url), 'utf8');
const TEAM = 'example-team.cloudflareaccess.com';
const AUD = 'test-aud-tag';
const TOKEN = 'x'.repeat(40);

// ---- helpers ----------------------------------------------------------------
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1' };
const certsFetch = async (url) => {
  assert.equal(url, `https://${TEAM}/cdn-cgi/access/certs`);
  return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } });
};
async function jwt(claims, header = { alg: 'RS256', kid: 'k1', typ: 'JWT' }) {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}
const now = () => Math.floor(Date.now() / 1000);
const goodClaims = () => ({ aud: [AUD], iss: `https://${TEAM}`, exp: now() + 600, iat: now(), email: 'ops@example.org' });

function fakeKV() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k); return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
  };
}
const env = (extra = {}) => ({ DASH_KV: fakeKV(), INGEST_TOKEN: TOKEN, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ...extra });
const app = createApp(PAGE, { fetchImpl: certsFetch });
const sample = () => ({
  schema: 1, built_at: new Date().toISOString(), courses: [{ id: 'ZZ101', name: 'Evil </script><script>alert(1)</script>' }],
  summary: {}, tools: {}, certificates: {}, publishing: {}, status: { overall: 'ok' },
  release: [], stage_counts: [], gaps: [], queue: [], recent_signoffs: [], signoffs_per_day: [], by_exam_date: [],
});

// ---- tests ------------------------------------------------------------------
test('timingSafeEqual', async () => {
  assert.equal(await timingSafeEqual('abc', 'abc'), true);
  assert.equal(await timingSafeEqual('abc', 'abd'), false);
  assert.equal(await timingSafeEqual('abc', 'abcd'), false);
  assert.equal(await timingSafeEqual(undefined, 'abc'), false);
});

test('renderPage escapes </script> and inlines data', () => {
  const html = renderPage(PAGE, sample(), { nonce: 'abcdefghijklmnop1234' });
  assert.ok(!html.includes('</script><script>alert'));
  assert.ok(html.includes('\\u003c/script>'));
  assert.ok(!html.includes('__NONCE__') && !html.includes('"__BOOT__"'));
  assert.equal(JSON.parse(safeJson('</x>')), '</x>');
  assert.throws(() => renderPage(PAGE, null, { nonce: 'short' }));
});

test('verifyAccessJwt accepts a good token and rejects bad ones', async () => {
  resetCertCache();
  const opts = { teamDomain: TEAM, aud: AUD, fetchImpl: certsFetch };
  assert.equal((await verifyAccessJwt(await jwt(goodClaims()), opts)).email, 'ops@example.org');
  await assert.rejects(verifyAccessJwt(await jwt({ ...goodClaims(), aud: ['other'] }), opts), /audience/);
  await assert.rejects(verifyAccessJwt(await jwt({ ...goodClaims(), iss: 'https://evil.example' }), opts), /issuer/);
  await assert.rejects(verifyAccessJwt(await jwt({ ...goodClaims(), exp: now() - 5 }), opts), /expired/);
  await assert.rejects(verifyAccessJwt(await jwt(goodClaims(), { alg: 'HS256', kid: 'k1' }), opts), /alg/);
  const t = await jwt(goodClaims());
  const tampered = t.split('.'); tampered[1] = b64url(JSON.stringify({ ...goodClaims(), email: 'x@y' }));
  await assert.rejects(verifyAccessJwt(tampered.join('.'), opts), /signature/);
  await assert.rejects(verifyAccessJwt(t, { ...opts, aud: '' }), /not configured/);
});

test('validatePayload', () => {
  assert.equal(validatePayload(sample()), null);
  assert.match(validatePayload({ ...sample(), schema: 2 }), /schema/);
  assert.match(validatePayload({ ...sample(), courses: [{ id: '../../x' }] }), /id/);
  assert.match(validatePayload([]), /object/);
});

test('ingest requires the bearer token and stores the payload', async () => {
  const e = env();
  const post = (auth, body) => app.fetch(new Request('https://dash.example/api/ingest', {
    method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body }), e);
  assert.equal((await post('Bearer wrong', '{}')).status, 401);
  assert.equal((await post(`Bearer ${TOKEN}`, '{"schema":1}')).status, 422);
  const ok = await post(`Bearer ${TOKEN}`, JSON.stringify(sample()));
  assert.equal(ok.status, 200);
  assert.ok(e.DASH_KV.m.has('latest'));
  const ctl = await app.fetch(new Request('https://dash.example/api/ingest', { headers: { authorization: `Bearer ${TOKEN}` } }), e);
  assert.deepEqual(await ctl.json(), { mode: 'paused', requested_at: null, requested_by: null });
  // a missing / short server token never accepts anything
  const weak = await app.fetch(new Request('https://dash.example/api/ingest', { headers: { authorization: 'Bearer ' } }), env({ INGEST_TOKEN: '' }));
  assert.equal(weak.status, 503);
});

test('page and APIs require Access; dev bypass only on localhost', async () => {
  const e = env();
  assert.equal((await app.fetch(new Request('https://dash.example/'), e)).status, 403);
  assert.equal((await app.fetch(new Request('https://dash.example/api/meta'), e)).status, 403);
  // ALLOW_DEV on a real hostname does nothing
  assert.equal((await app.fetch(new Request('https://dash.example/'), env({ ALLOW_DEV: '1' }))).status, 403);
  assert.equal(devBypass({ ALLOW_DEV: '1' }, new URL('http://localhost:8787/')), true);
  assert.equal(devBypass({ ALLOW_DEV: 'true' }, new URL('http://localhost:8787/')), false);
  assert.equal(devBypass({}, new URL('http://127.0.0.1:8787/')), false);

  resetCertCache();
  const res = await app.fetch(new Request('https://dash.example/', { headers: { 'cf-access-jwt-assertion': await jwt(goodClaims()) } }), e);
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /script-src 'nonce-[^']+'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  const nonce = /nonce-([^']+)/.exec(csp)[1];
  assert.ok((await res.text()).includes(`<script nonce="${nonce}">`));
});

test('control: JSON only, same origin, records who', async () => {
  const e = env();
  resetCertCache();
  const auth = { 'cf-access-jwt-assertion': await jwt(goodClaims()) };
  const call = (headers, body) => app.fetch(new Request('https://dash.example/api/control', { method: 'POST', headers: { ...auth, ...headers }, body }), e);
  assert.equal((await call({ 'content-type': 'application/x-www-form-urlencoded' }, 'action=update')).status, 415);
  assert.equal((await call({ 'content-type': 'application/json', origin: 'https://evil.example' }, '{"action":"update"}')).status, 403);
  assert.equal((await call({ 'content-type': 'application/json' }, '{"action":"explode"}')).status, 400);
  const start = await (await call({ 'content-type': 'application/json', origin: 'https://dash.example' }, '{"action":"start"}')).json();
  assert.equal(start.mode, 'auto');
  assert.equal(start.requested_by, 'ops@example.org');
  assert.ok(start.requested_at);
  const paused = await (await call({ 'content-type': 'application/json' }, '{"action":"pause"}')).json();
  assert.equal(paused.mode, 'paused');
  assert.equal(paused.requested_at, start.requested_at);
});
