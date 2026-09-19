import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import unzipper from 'unzipper';

const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';
const ARCHIVE_URL = process.env.SOLY_ARCHIVE_URL || 'https://bfffd39b-4b61-49af-a460-99fe69eaa823.sandbox.floot.app/_cdn/static/fb88c6a8-f35a-4f5b-af24-191400baa37b-grok-workspace.zip';
const RUNTIME_ROOT = path.resolve('runtime');
const APP_ROOT = path.join(RUNTIME_ROOT, 'app');
const SERVER_ENTRY = path.join(APP_ROOT, '.vercel', 'output', 'functions', '__server.func', 'index.mjs');
const STATIC_ROOT = path.join(APP_ROOT, '.vercel', 'output', 'static');

function mime(file) {
  const ext = path.extname(file).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
  })[ext] || 'application/octet-stream';
}

async function ensureWorkspace() {
  if (fs.existsSync(SERVER_ENTRY)) return;
  fs.rmSync(APP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(APP_ROOT, { recursive: true });
  console.log('[soly-host] downloading uploaded workspace');
  const response = await fetch(ARCHIVE_URL);
  if (!response.ok || !response.body) {
    throw new Error('workspace download failed: ' + response.status);
  }
  await new Promise((resolve, reject) => {
    Readable.fromWeb(response.body)
      .pipe(unzipper.Extract({ path: APP_ROOT }))
      .on('close', resolve)
      .on('error', reject);
  });
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error('workspace extracted but prebuilt server entry is missing');
  }
}

function safeStaticPath(urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(urlPath, 'http://local').pathname);
  } catch {
    return null;
  }
  const rel = pathname.replace(/^\/+/, '');
  const candidate = path.resolve(STATIC_ROOT, rel);
  const root = path.resolve(STATIC_ROOT) + path.sep;
  if (candidate !== path.resolve(STATIC_ROOT) && !candidate.startsWith(root)) return null;
  return candidate;
}

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 20 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function main() {
  await ensureWorkspace();
  const nitro = (await import(pathToFileURL(SERVER_ENTRY).href)).default;
  if (!nitro || typeof nitro.fetch !== 'function') {
    throw new Error('Nitro fetch handler not found');
  }

  const server = http.createServer(async (req, res) => {
    try {
      const staticFile = safeStaticPath(req.url || '/');
      if (staticFile && fs.existsSync(staticFile) && fs.statSync(staticFile).isFile()) {
        res.statusCode = 200;
        res.setHeader('content-type', mime(staticFile));
        const stat = fs.statSync(staticFile);
        res.setHeader('content-length', stat.size);
        if (/\/assets\//.test(req.url || '')) {
          res.setHeader('cache-control', 'public, max-age=31536000, immutable');
        }
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(staticFile).pipe(res);
      }

      const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) headers.append(key, item);
        } else {
          headers.set(key, value);
        }
      }
      const body = await readBody(req);
      const request = new Request(proto + '://' + host + (req.url || '/'), {
        method: req.method || 'GET',
        headers,
        body,
        ...(body ? { duplex: 'half' } : {}),
      });
      const response = await nitro.fetch(request, { waitUntil() {} });
      res.statusCode = response.status;
      const cookies = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [];
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'set-cookie') return;
        res.setHeader(key, value);
      });
      if (cookies.length) res.setHeader('set-cookie', cookies);
      if (req.method === 'HEAD' || !response.body) return res.end();
      Readable.fromWeb(response.body).pipe(res);
    } catch (error) {
      console.error('[soly-host] request error', error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json; charset=utf-8');
      }
      res.end(JSON.stringify({ ok: false, error: 'Soly AI Pro host error' }));
    }
  });

  server.listen(PORT, HOST, () => {
    console.log('[soly-host] Soly AI Pro listening on ' + HOST + ':' + PORT);
  });
}

main().catch((error) => {
  console.error('[soly-host] fatal', error);
  process.exit(1);
});
