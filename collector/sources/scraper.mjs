// Example Playwright adapter for a web tool that has no API.
//
// It opens read-only report pages in a real Chrome window with a persistent
// profile (so the sign-in is remembered), and reads HTML tables, including
// DataTables-paginated ones. It never clicks anything except pagination.
//
//   npm install --prefix collector playwright-core   (optional dependency)
//
// Per-page outcome:
//   ok       table read
//   partial  page loaded but the table never appeared (slow report, empty
//            render): the previous good read of that table is kept
//   expired  the page redirected to / showed a sign-in screen: sign in again
//            in the collector's Chrome window; previous reads are kept
//   failed   navigation error; previous reads are kept
// The tool source takes the worst status across its pages.
import path from 'node:path';

const RANK = { ok: 0, partial: 1, expired: 2, failed: 3 };
const SIGNIN_PATH = /(log-?in|sign-?in|sso|auth|session-?expired)/i;
const SIGNIN_TITLE = /(sign in|log in|login|session (has )?expired)/i;

async function context(shared, root, profileDir, log) {
  if (shared.context) {
    try { shared.context.pages(); return shared.context; } catch { shared.context = null; }
  }
  let pw;
  try {
    pw = await import('playwright-core');
  } catch {
    throw new Error('playwright-core is not installed (npm install --prefix collector playwright-core)');
  }
  const dir = path.resolve(root, profileDir || 'profile');
  log(`scraper: launching Chrome with profile ${dir}`);
  // headless: false on purpose: a person may need to complete a sign-in here.
  shared.context = await pw.chromium.launchPersistentContext(dir, { channel: 'chrome', headless: false, viewport: null });
  shared.context.on('close', () => { shared.context = null; });
  return shared.context;
}

async function signedOut(page, cfg) {
  const url = new URL(page.url());
  const expected = new URL(cfg.url);
  if (url.host !== expected.host) return `redirected to ${url.host}`;
  if (SIGNIN_PATH.test(url.pathname) && !SIGNIN_PATH.test(expected.pathname)) return `redirected to ${url.pathname}`;
  if (await page.locator('input[type="password"]').count()) return 'sign-in form shown';
  if (SIGNIN_TITLE.test(await page.title())) return 'sign-in page title';
  return null;
}

// Runs in the page. Reads header + visible body rows of one table.
function readVisible(selector) {
  const table = document.querySelector(selector);
  if (!table) return null;
  const clean = (el) => el.textContent.replace(/\s+/g, ' ').trim();
  let headRow = table.querySelector('thead tr:last-child') || table.querySelector('tr');
  const headers = Array.from(headRow.querySelectorAll('th,td')).map(clean);
  const rows = Array.from(table.querySelectorAll('tbody tr'))
    .filter((tr) => tr !== headRow && !tr.querySelector('td.dataTables_empty'))
    .map((tr) => Array.from(tr.querySelectorAll('td')).map(clean));
  return { headers, rows };
}

async function readTable(page, selector) {
  // DataTables: ask for "show all" when the API is there (client-side tables).
  await page.evaluate((sel) => {
    const $ = window.jQuery;
    if ($ && $.fn && $.fn.dataTable && $.fn.dataTable.isDataTable(sel)) $(sel).DataTable().page.len(-1).draw(false);
  }, selector).catch(() => {});
  await page.waitForTimeout(300);

  const first = await page.evaluate(readVisible, selector);
  if (!first) return null;
  const seen = new Set(first.rows.map((r) => JSON.stringify(r)));
  const rows = [...first.rows];

  // Server-side DataTables ignore "show all": click "Next" until it is disabled.
  const wrapper = `${selector}_wrapper`;
  for (let i = 0; i < 500; i++) {
    const next = page.locator(`${wrapper} .paginate_button.next:not(.disabled), ${wrapper} .dt-paging-button.next:not(.disabled)`).first();
    if (!(await next.count())) break;
    const before = JSON.stringify(rows[rows.length - 1] || '');
    await next.click();
    await page.waitForFunction(([sel, b]) => {
      const trs = document.querySelectorAll(`${sel} tbody tr`);
      const last = trs[trs.length - 1];
      return last && JSON.stringify(Array.from(last.querySelectorAll('td')).map((td) => td.textContent.replace(/\s+/g, ' ').trim())) !== b;
    }, [selector, before], { timeout: 15_000 }).catch(() => {});
    const pageRows = (await page.evaluate(readVisible, selector))?.rows || [];
    let added = 0;
    for (const r of pageRows) {
      const k = JSON.stringify(r);
      if (!seen.has(k)) { seen.add(k); rows.push(r); added++; }
    }
    if (!added) break;
  }
  return { headers: first.headers, rows };
}

export async function read({ pages, shared, prev, root, log, profileDir }) {
  const read_at = new Date().toISOString();
  let previous = { tables: {} };
  try { previous = JSON.parse((await prev('tool.json')) || '{"tables":{}}'); } catch { /* none */ }
  const tables = { ...(previous.tables || {}) };
  const notes = [];
  let status = 'ok';
  const mark = (s, note) => { if (RANK[s] > RANK[status]) status = s; notes.push(note); };

  let ctx;
  try {
    ctx = await context(shared, root, profileDir, log);
  } catch (e) {
    return { outputs: {}, sources: { tool: { status: 'failed', detail: e.message, read_at } } };
  }

  for (const cfg of pages) {
    const page = await ctx.newPage();
    try {
      await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      const why = await signedOut(page, cfg);
      if (why) { mark('expired', `${cfg.name}: ${why}`); continue; }
      const found = await page.waitForSelector(cfg.table, { timeout: cfg.timeout_ms || 20_000 }).catch(() => null);
      const t = found ? await readTable(page, cfg.table) : null;
      if (!t || !t.rows.length) {
        mark('partial', `${cfg.name}: no table${tables[cfg.name] ? ', kept previous read' : ''}`);
        continue;
      }
      tables[cfg.name] = t;
      notes.push(`${cfg.name}: ${t.rows.length} rows`);
    } catch (e) {
      mark('failed', `${cfg.name}: ${e.message.split('\n')[0]}`);
    } finally {
      await page.close().catch(() => {});
    }
  }

  const outputs = {};
  // Write tool.json if at least one table was read this time; expired/failed
  // pages simply keep whatever the previous good read had.
  if (notes.some((n) => /rows$/.test(n))) {
    outputs['tool.json'] = JSON.stringify({ source: 'scraper', scraped_at: read_at, tables }, null, 1);
  }
  log(`scraper: ${status} (${notes.join('; ')})`);
  return { outputs, sources: { tool: { status, detail: notes.join('; '), read_at } } };
}
