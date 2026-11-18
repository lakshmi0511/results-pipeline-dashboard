// Shared by the Worker (GET /) and the collector's --local preview.
// Inlines the dashboard data into page.html. No Worker-only APIs here.

/**
 * Serialise a value so it is safe inside <script type="application/json">.
 * Escaping every "<" means a course name containing "</script>" (or "<!--")
 * can never close the tag early; JSON.parse turns < back into "<".
 */
export function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * @param {string} template  contents of page.html
 * @param {object|null} data  state/data.json (null before the first ingest)
 * @param {{nonce: string, control?: object|null, preview?: boolean}} opts
 */
export function renderPage(template, data, { nonce, control = null, preview = false }) {
  if (!/^[A-Za-z0-9+/=_-]{16,}$/.test(nonce || '')) throw new Error('renderPage: bad nonce');
  const boot = safeJson({ data: data ?? null, control, preview: Boolean(preview) });
  // Replace the nonce first, then insert data with a replacer function so "$&"
  // style patterns inside the data are never interpreted.
  return template.replaceAll('__NONCE__', nonce).replace('"__BOOT__"', () => boot);
}
