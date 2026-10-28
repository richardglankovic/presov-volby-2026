import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('../site/', import.meta.url)));
const port = Number(process.env.PORT || 4173);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.geojson': 'application/geo+json; charset=utf-8', '.svg': 'image/svg+xml' };
createServer(async (req, res) => {
  try {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (name === '/__qa/stale-html') {
      const html = (await readFile(resolve(root, '../tmp/old-index.html'), 'utf8')).replace('<head>', '<head><base href="/">');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    if (name === '/__qa/address-audit') {
      const body = await readFile(resolve(root, '../tmp/address-review.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(body);
      return;
    }
    // Local QA only: an iframe gives the app a real 390 px CSS viewport without
    // adding a test page to the published site or changing the user's browser.
    if (name === '/__qa/mobile') {
      const query = new URL(req.url, 'http://localhost').search.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Mobile QA — 390 × 844</title></head><body style="margin:0;background:#dce1df;display:flex;justify-content:center"><iframe title="Prešov mobile preview" src="/${query}" style="width:390px;height:844px;border:0;background:white"></iframe></body></html>`);
      return;
    }
    if (name === '/__qa/council-data-error') {
      const shim = '<script>{const originalFetch=window.fetch.bind(window);let failures=2;window.fetch=(input,options)=>String(input).includes("council-results.json")&&failures-->0?Promise.resolve(new Response("Local QA failure",{status:503})):originalFetch(input,options);}</script>';
      const html = (await readFile(resolve(root, 'index.html'), 'utf8')).replace('<head>', '<head><base href="/">' + shim);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    if (name === '/__qa/no-basemap') {
      const html = (await readFile(resolve(root, 'index.html'), 'utf8')).replace('<head>', '<head><base href="/">');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "connect-src 'self'" });
      res.end(html);
      return;
    }
    if (name === '/__qa/continuous-areas') {
      // Keep previously shared local review links working after promotion.
      const html = (await readFile(resolve(root, 'index.html'), 'utf8'))
        .replace('<head>', '<head><base href="/">');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(html);
      return;
    }
    if (name === '/__qa/delayed-basemap' || name === '/__qa/retry-basemap') {
      // Exercise the real browser lifecycle with delayed or transiently failed
      // style loading. These routes exist only on the local development server.
      const failFirst = name.endsWith('retry-basemap');
      const shim = `<script>{ const originalFetch = window.fetch.bind(window); let first = true; window.fetch = async (input, options) => { if (String(input).includes('tiles.openfreemap.org/styles/')) { if (${failFirst} && first) { first = false; throw new TypeError('Intentional local QA network failure'); } await new Promise(resolve => setTimeout(resolve, 400)); } return originalFetch(input, options); }; }</script>`;
      const html = (await readFile(resolve(root, 'index.html'), 'utf8')).replace('<head>', '<head><base href="/">' + shim);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(html);
      return;
    }
    let path = resolve(root, '.' + name);
    if (path !== root && !path.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
    if ((await stat(path)).isDirectory()) path = resolve(path, 'index.html');
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}`));
