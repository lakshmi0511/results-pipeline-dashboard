// Demo adapter: serves the committed synthetic files from sample/, nudging a
// few courses one workflow step forward each cycle so repeated runs change.
// Progress carries over between cycles via state/tool.json.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const FLAGS = ['Home', 'QP Check', 'Moderation', 'Score Summary', 'Signoff', 'Verified'];

export async function read({ root, prev, log }) {
  const sample = path.join(root, 'sample');
  const now = new Date().toISOString();
  const outputs = {};
  const sources = {};
  try {
    const base = JSON.parse(await readFile(path.join(sample, 'tool.json'), 'utf8'));
    let tool = base;
    const last = await prev('tool.json');
    if (last) {
      try {
        const t = JSON.parse(last);
        if (t.source === 'sample') tool = t; // continue from the previous demo cycle
      } catch { /* fall back to the sample */ }
    }
    const { headers, rows } = tool.tables.course_list;
    const cols = FLAGS.map((f) => headers.indexOf(f));
    const behind = rows.filter((r) => cols.some((i) => r[i] !== 'Yes'));
    const nudge = Math.min(behind.length, 1 + Math.floor(Math.random() * 4));
    for (let k = 0; k < nudge; k++) {
      const row = behind.splice(Math.floor(Math.random() * behind.length), 1)[0];
      const i = cols.find((c) => row[c] !== 'Yes');
      row[i] = 'Yes';
    }
    tool.scraped_at = now;
    outputs['tool.json'] = JSON.stringify(tool, null, 1);
    sources.tool = { status: 'ok', detail: `sample data, ${nudge} course step(s) advanced`, read_at: now };
    for (const name of ['planner', 'aftercheck', 'signoff']) {
      outputs[`${name}.csv`] = await readFile(path.join(sample, `${name}.csv`), 'utf8');
      sources[name] = { status: 'ok', detail: 'sample data', read_at: now };
    }
    log(`demo: ${nudge} course step(s) advanced`);
    return { outputs, sources, as_of: base.as_of };
  } catch (e) {
    const detail = e.code === 'ENOENT' ? 'sample files missing: run python3 sample/generate.py' : e.message;
    return { outputs: {}, sources: { tool: { status: 'failed', detail, read_at: now } } };
  }
}
