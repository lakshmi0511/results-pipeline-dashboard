// Cloudflare Worker entry point. page.html is bundled as a text module
// (see [[rules]] in wrangler.toml).
import PAGE from './page.html';
import { createApp } from './app.js';

export default createApp(PAGE);
