// Spreadsheet adapter: downloads each sheet as CSV from an export URL.
//
// The one rule that matters: only text/csv is ever saved as data. If a sheet's
// sharing changes or a session lapses, the export URL quietly returns an HTML
// sign-in page with HTTP 200. Saving that would wipe the dashboard, so it is
// reported as 'expired' and the previous good CSV in state/ is kept.

export async function read({ sheets, log }) {
  const outputs = {};
  const sources = {};
  for (const [name, url] of Object.entries(sheets)) {
    const read_at = new Date().toISOString();
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
      const type = (res.headers.get('content-type') || '').toLowerCase();
      if (!res.ok) {
        sources[name] = { status: 'failed', detail: `HTTP ${res.status}; kept previous copy`, read_at };
        continue;
      }
      if (!type.includes('text/csv')) {
        sources[name] = { status: 'expired', detail: `got ${type.split(';')[0] || 'unknown type'} instead of CSV (sign-in page?); kept previous copy`, read_at };
        continue;
      }
      const text = await res.text();
      if (/^\s*</.test(text) || !text.includes(',')) {
        sources[name] = { status: 'expired', detail: 'response does not look like CSV; kept previous copy', read_at };
        continue;
      }
      outputs[`${name}.csv`] = text;
      const rows = text.trim().split('\n').length - 1;
      sources[name] = { status: 'ok', detail: `${rows} rows`, read_at };
    } catch (e) {
      sources[name] = { status: 'failed', detail: `${e.name === 'TimeoutError' ? 'timed out' : e.message}; kept previous copy`, read_at };
    }
    log(`sheets: ${name} ${sources[name].status}`);
  }
  return { outputs, sources };
}
