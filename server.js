const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

function extractShareIds(inputUrl) {
  const m = String(inputUrl || '').match(/\/am\/share\/u\/([^/?#]+)\/p\/([^/?#]+)/i);
  if (!m) return null;
  const uid = m[1];
  const pidRaw = m[2];
  const pidClean = pidRaw.replace(/-(?:[0-9a-fA-F]{6,})$/, '');
  return { uid, pidRaw, pidClean };
}

async function resolveAlightLinkToShareIds(rawUrl) {
  const direct = extractShareIds(rawUrl);
  if (direct) return direct;

  // Follow redirects for alight.link shortlinks
  const resp = await fetch(rawUrl, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'User-Agent': 'AlightMotion/6.2.53 (iOS; gzip)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });

  const finalIds = extractShareIds(resp.url);
  if (finalIds) return finalIds;

  const bodyText = await resp.text();
  const bodyIds = extractShareIds(bodyText);
  if (bodyIds) return bodyIds;

  return null;
}

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // Direct Alight Creative Firebase Storage ZIP / XML Endpoint
    if (parsedUrl.pathname === '/api/am/direct-zip') {
      const targetUrl = parsedUrl.searchParams.get('url') || '';
      if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Parameter url wajib diisi.' }));
        return;
      }

      try {
        if (targetUrl.includes('firebasestorage.googleapis.com')) {
          const fbResp = await fetch(targetUrl, {
            headers: { 'User-Agent': 'AlightMotion/6.2.53 (iOS; gzip)' }
          });
          if (!fbResp.ok) throw new Error(`Firebase Storage HTTP ${fbResp.status}`);
          const buf = Buffer.from(await fbResp.arrayBuffer());
          res.writeHead(200, {
            'Content-Type': fbResp.headers.get('content-type') || 'application/zip',
            'Content-Length': buf.length,
            'Access-Control-Allow-Origin': '*'
          });
          res.end(buf);
          return;
        }

        const ids = await resolveAlightLinkToShareIds(targetUrl);
        if (ids) {
          const storagePath = `share/u/${ids.uid}/p/${ids.pidClean}.amproj`;
          const fbUrl = `https://firebasestorage.googleapis.com/v0/b/alight-creative.appspot.com/o/${encodeURIComponent(storagePath)}?alt=media`;
          const fbResp = await fetch(fbUrl, {
            headers: { 'User-Agent': 'AlightMotion/6.2.53 (iOS; gzip)' }
          });
          if (fbResp.ok) {
            const buf = Buffer.from(await fbResp.arrayBuffer());
            res.writeHead(200, {
              'Content-Type': 'application/zip',
              'Content-Disposition': `attachment; filename="${ids.pidClean}.zip"`,
              'Content-Length': buf.length,
              'Access-Control-Allow-Origin': '*'
            });
            res.end(buf);
            return;
          }
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Paket langsung tidak ditemukan, gunakan fallback Cloudflare Worker.' }));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err.message || err) }));
      }
      return;
    }

    // Static file serving
    let relPath = decodeURIComponent(parsedUrl.pathname);
    if (relPath === '/') relPath = '/index.html';
    const safePath = path.normalize(path.join(ROOT, relPath));
    if (!safePath.startsWith(ROOT)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.stat(safePath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
      }
      const ext = path.extname(safePath).toLowerCase();
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      fs.createReadStream(safePath).pipe(res);
    });
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal Server Error: ' + e.message);
  }
});

server.listen(PORT, () => {
  console.log(`Alight Motion PC Studio berjalan di http://localhost:${PORT}`);
});
