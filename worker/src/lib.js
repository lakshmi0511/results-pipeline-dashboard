// Small, dependency-free helpers for the Worker. Pure functions where possible
// so they can be unit-tested with `node --test`.

const enc = new TextEncoder();

/** Constant-time string comparison: hash both sides, then compare every byte. */
export async function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0 && a.length === b.length;
}

export function bearer(request) {
  const h = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : '';
}

export const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;

/** Shape check for an ingest payload. Returns an error string, or null if OK. */
export function validatePayload(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return 'payload must be a JSON object';
  if (d.schema !== 1) return 'unsupported schema (expected 1)';
  if (typeof d.built_at !== 'string' || Number.isNaN(Date.parse(d.built_at))) return 'built_at must be an ISO timestamp';
  if (!Array.isArray(d.courses) || d.courses.length > 10000) return 'courses must be an array (max 10000)';
  for (const c of d.courses) {
    if (!c || typeof c.id !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(c.id)) return 'every course needs a short id';
  }
  for (const k of ['summary', 'tools', 'certificates', 'publishing', 'status']) {
    if (!d[k] || typeof d[k] !== 'object') return `missing object: ${k}`;
  }
  for (const k of ['release', 'stage_counts', 'gaps', 'queue', 'recent_signoffs', 'signoffs_per_day', 'by_exam_date']) {
    if (!Array.isArray(d[k])) return `missing array: ${k}`;
  }
  return null;
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

let certCache = { url: '', keys: null, at: 0 };

async function accessKeys(teamDomain, fetchImpl, force = false) {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  if (!force && certCache.url === url && certCache.keys && Date.now() - certCache.at < 10 * 60_000) {
    return certCache.keys;
  }
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`certs endpoint returned ${res.status}`);
  const { keys } = await res.json();
  if (!Array.isArray(keys)) throw new Error('certs endpoint returned no keys');
  certCache = { url, keys, at: Date.now() };
  return keys;
}

export function resetCertCache() { certCache = { url: '', keys: null, at: 0 }; }

/**
 * Verify a Cloudflare Access JWT (Cf-Access-Jwt-Assertion header).
 * Checks: RS256 only, signature against the team's published keys (by kid),
 * audience (the Access application AUD tag), issuer, exp and nbf.
 * Returns the claims on success, throws otherwise.
 */
export async function verifyAccessJwt(token, { teamDomain, aud, fetchImpl = fetch, now = Date.now() }) {
  if (!teamDomain || !aud) throw new Error('Access is not configured (ACCESS_TEAM_DOMAIN / ACCESS_AUD)');
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const header = b64urlJson(parts[0]);
  const claims = b64urlJson(parts[1]);
  if (header.alg !== 'RS256') throw new Error('unexpected alg');

  let keys = await accessKeys(teamDomain, fetchImpl);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { // keys rotate: refetch once before giving up
    keys = await accessKeys(teamDomain, fetchImpl, true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error('unknown signing key');

  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]),
    enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new Error('bad signature');

  const sec = Math.floor(now / 1000);
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) throw new Error('wrong audience');
  if (claims.iss !== `https://${teamDomain}`) throw new Error('wrong issuer');
  if (typeof claims.exp !== 'number' || claims.exp <= sec) throw new Error('token expired');
  if (typeof claims.nbf === 'number' && claims.nbf > sec + 60) throw new Error('token not yet valid');
  return claims;
}

export function nonce() {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_');
}

export function securityHeaders(extra = {}, cspNonce = null) {
  const csp = cspNonce
    ? `default-src 'none'; script-src 'nonce-${cspNonce}'; style-src 'nonce-${cspNonce}'; ` +
      `img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
    : `default-src 'none'; frame-ancestors 'none'`;
  return {
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'cache-control': 'no-store',
    ...extra,
  };
}
