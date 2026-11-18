#!/usr/bin/env node
// Long-running collector.
//
//   node collector/collector.mjs              poll the Worker, read sources when asked
//   node collector/collector.mjs --once       run one cycle now, post it, exit
//   node collector/collector.mjs --local      no Worker: write preview.html instead
//   node collector/collector.mjs --local --once   (the zero-setup demo)
//
// Every 20 s it fetches the Worker's control record (GET {ingest_url}) and runs
// a cycle when someone pressed "Update now" (a new requested_at), or every
// 5 minutes while auto-update is on. Requests made before start-up count as
// already handled, so restarting never triggers a surprise read.
//
// cycle.mjs (and the source adapters) are re-imported whenever their files
// change, without restarting this process. That matters for the live scraper:
// it drives a real Chrome window that someone signed in to by hand (SSO,
// sometimes with a one-time code). Restarting the process would close that
// browser and need another manual sign-in; hot-reloading means a fix to the
// cycle or an adapter takes effect on the next tick while the signed-in
// browser, held in `shared` below, stays open.
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const POLL_MS = 20_000;
const AUTO_MS = 5 * 60_000;

const argv = new Set(process.argv.slice(2));
const LOCAL = argv.has('--local');
const ONCE = argv.has('--once');
if (argv.has('--help') || argv.has('-h')) {
  console.log('usage: node collector/collector.mjs [--local] [--once]');
  process.exit(0);
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// State that must survive hot reloads (e.g. the signed-in browser context).
const shared = { context: null };

async function loadConfig() {
  const file = path.join(HERE, 'config.json');
  let cfg = {};
  try {
    cfg = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`collector/config.json: ${e.message}`);
    if (!LOCAL) throw new Error('collector/config.json not found. Copy config.example.json, or use --local for the demo.');
  }
  cfg.source ||= 'demo';
  if (LOCAL) cfg.source = cfg.source === 'live' ? 'live' : 'demo';
  if (!LOCAL && (!cfg.ingest_url || !cfg.ingest_token)) throw new Error('config.json needs ingest_url and ingest_token');
  return cfg;
}

// Version = newest mtime of cycle.mjs + sources/*.mjs. Re-import only when it
// changes, so we do not pile up a new module copy on every tick.
async function codeVersion() {
  const files = [path.join(HERE, 'cycle.mjs')];
  for (const f of await readdir(path.join(HERE, 'sources'))) if (f.endsWith('.mjs')) files.push(path.join(HERE, 'sources', f));
  let v = 0;
  for (const f of files) v = Math.max(v, (await stat(f)).mtimeMs);
  return String(Math.floor(v));
}
let loaded = { version: null, mod: null };
async function loadCycle() {
  const version = await codeVersion();
  if (version !== loaded.version) {
    const mod = await import(`${pathToFileURL(path.join(HERE, 'cycle.mjs')).href}?v=${version}`);
    if (loaded.version) log('reloaded cycle.mjs');
    loaded = { version, mod };
  }
  return loaded;
}

let running = false;
async function runOnce(reason) {
  if (running) { log('cycle already running; skipped', reason); return null; }
  running = true;
  const t0 = Date.now();
  try {
    const config = await loadConfig();
    const { mod, version } = await loadCycle();
    log(`cycle start (${reason}, source=${config.source}${LOCAL ? ', local' : ''})`);
    const result = await mod.runCycle({ config, root: ROOT, shared, local: LOCAL, version, log });
    log(`cycle done in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, JSON.stringify(result.summary));
    return result;
  } catch (e) {
    log('cycle failed:', e.message);
    return null;
  } finally {
    running = false;
  }
}

async function fetchControl(cfg) {
  const res = await fetch(cfg.ingest_url, {
    headers: { authorization: `Bearer ${cfg.ingest_token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`control record: HTTP ${res.status}`);
  return res.json();
}

async function shutdown(code = 0) {
  try { await shared.context?.close(); } catch { /* already gone */ }
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function main() {
  if (ONCE) {
    const r = await runOnce('--once');
    return shutdown(r ? 0 : 1);
  }

  if (LOCAL) {
    log(`local mode: rebuilding preview.html every ${AUTO_MS / 60000} min (Ctrl-C to stop)`);
    await runOnce('start');
    setInterval(() => runOnce('local timer'), AUTO_MS);
    return;
  }

  let handled = undefined; // requested_at we have already acted on
  let lastAuto = 0;
  const tick = async () => {
    try {
      const cfg = await loadConfig();
      await loadCycle(); // pick up code changes even while idle
      const ctl = await fetchControl(cfg);
      if (handled === undefined) {
        handled = ctl.requested_at ?? null; // anything requested before start-up is old news
        log(`watching control record (mode=${ctl.mode}${handled ? `, last request ${handled}` : ''})`);
        if (ctl.mode !== 'auto') return;
      }
      if (ctl.requested_at && ctl.requested_at !== handled) {
        handled = ctl.requested_at;
        lastAuto = Date.now();
        await runOnce(`requested by ${ctl.requested_by || 'unknown'}`);
      } else if (ctl.mode === 'auto' && Date.now() - lastAuto >= AUTO_MS) {
        lastAuto = Date.now();
        await runOnce('auto');
      }
    } catch (e) {
      log('tick:', e.message);
    }
  };
  await tick();
  setInterval(tick, POLL_MS);
}

main().catch((e) => { console.error(e); shutdown(1); });
