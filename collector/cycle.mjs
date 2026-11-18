// One collection cycle: read sources -> save raw inputs -> build -> publish.
// Re-imported by collector.mjs whenever this file or an adapter changes.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const RANK = { ok: 0, partial: 1, expired: 2, failed: 3 };
export const worst = (list) => list.reduce((w, s) => (RANK[s] > RANK[w] ? s : w), 'ok');

export async function runCycle({ config, root, shared, local, version, log }) {
  const stateDir = path.join(root, 'state');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);

  const prev = async (name) => {
    try { return await readFile(path.join(stateDir, name), 'utf8'); } catch { return null; }
  };
  const save = async (name, content) => {
    const file = path.join(stateDir, name);
    await writeFile(file, content, { mode: 0o600 });
    await chmod(file, 0o600); // mode only applies on create
  };

  // Adapters are imported with the same version tag, so they hot-reload too.
  const load = (name) => import(`./sources/${name}.mjs?v=${version}`);
  const results = [];
  if (config.source === 'live') {
    const [sheets, scraper] = await Promise.all([load('sheets'), load('scraper')]);
    results.push(await scraper.read({ pages: config.pages || [], shared, prev, root, log, profileDir: config.profile_dir }));
    results.push(await sheets.read({ sheets: config.sheets || {}, log }));
  } else {
    const demo = await load('demo');
    results.push(await demo.read({ root, prev, log }));
  }

  // Only overwrite inputs that were read successfully. A failed or expired
  // source leaves the previous good file in state/, and the build uses that.
  const sources = {};
  let asOf = null;
  for (const r of results) {
    for (const [name, content] of Object.entries(r.outputs || {})) await save(name, content);
    Object.assign(sources, r.sources);
    asOf ||= r.as_of || null;
  }
  const status = { overall: worst(Object.values(sources).map((s) => s.status)), sources };
  if (asOf) status.as_of = asOf;

  // -I: isolated mode (ignore PYTHON* env vars and the user site directory).
  const { stdout } = await run('python3', ['-I', path.join(root, 'build', 'build.py'), stateDir, JSON.stringify(status)], {
    cwd: root, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  const summary = JSON.parse(stdout.trim().split('\n').pop());
  const data = await readFile(path.join(stateDir, 'data.json'), 'utf8');

  if (local) {
    const { renderPage } = await import(pathToFileURL(path.join(root, 'worker', 'src', 'render.js')).href);
    const template = await readFile(path.join(root, 'worker', 'src', 'page.html'), 'utf8');
    const nonce = randomBytes(18).toString('base64url');
    const html = renderPage(template, JSON.parse(data), { nonce, preview: true });
    await writeFile(path.join(root, 'preview.html'), html);
    log('wrote preview.html');
    return { summary, status, preview: path.join(root, 'preview.html') };
  }

  const res = await fetch(config.ingest_url, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.ingest_token}`, 'content-type': 'application/json' },
    body: data,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`ingest failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  log('posted data.json to the Worker');
  return { summary, status };
}
