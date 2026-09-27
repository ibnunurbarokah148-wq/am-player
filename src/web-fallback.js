/* web-fallback.js
 * Minimal desktop bridge shim so the AM Preset Player UI runs in a plain
 * browser through the index.js HTTP server, not just inside Electron.
 *
 * It mirrors the four ipcRenderer.invoke() shapes used by src/renderer.js:
 *   openFile()        -> File|null
 *   readFile(p)       -> { scenes:[{name,text}] }
 *   openMedia()       -> Array<{path,name,mime,kind,url,size}>
 *   resolveShare(url) -> { metadata, scenes? | requiresResolver }
 *
 * No Electron dependency. JSZip is loaded optionally for .zip/.alight packages.
 */
(() => {
  // Electron (or any host) already injected the real bridge -> stay out of the way.
  if (typeof window === 'undefined' || window.desktop) return;
  // _"the browser has no fs, so we ride File objects like a skateboard"_

  const MIME = {
    '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp',
    '.gif':'image/gif','.bmp':'image/bmp','.mp4':'video/mp4','.m4v':'video/mp4',
    '.webm':'video/webm','.mov':'video/quicktime','.mkv':'video/x-matroska',
    '.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4','.aac':'audio/aac',
    '.ogg':'audio/ogg','.opus':'audio/ogg','.flac':'audio/flac'
  };
  const IMAGE_EXT = ['jpg','jpeg','png','webp','gif','bmp'];
  const VIDEO_EXT = ['mp4','m4v','webm','mov','mkv'];
  const AUDIO_EXT = ['mp3','wav','m4a','aac','ogg','opus','flac'];

  const ext = p => String(p || '').split('.').pop().toLowerCase();
  const mimeFor = p => MIME['.' + ext(p)] || 'application/octet-stream';
  const kindFor = m =>
    m.startsWith('image/') ? 'image' :
    m.startsWith('video/') ? 'video' :
    m.startsWith('audio/') ? 'audio' : 'other';
  const baseName = p => String(p || '').replace(/^.*[\\/,/,]/, '') || p;
  // _"baseName has to cope with both windows-ish and unix path separators"_

  const scenesFromZip = async (src) => {
    const JSZip = window.JSZip;
    if (!JSZip) throw new Error('JSZip belum termuat; sertakan /vendor/jszip.min.js');
    let buf = src;
    if (typeof src?.arrayBuffer === 'function') buf = await src.arrayBuffer();
    const zip = await JSZip.loadAsync(buf);
    const scenes = [];
    for (const f of Object.values(zip.files)) {
      if (f.dir || !/\.xml$/i.test(f.name)) continue;
      const text = await f.async('string');
      if (/^\s*(?:<\?xml[^>]*>\s*)?<scene[\s>]/i.test(text)) scenes.push({ name: baseName(f.name), text });
    }
    return scenes;
  };

  const fileFromInput = (opts) => new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (opts && opts.multiple) input.multiple = true;
    if (opts && opts.accept) input.accept = opts.accept;
    input.onchange = () => resolve(input.files ? Array.from(input.files) : []);
    input.oncancel = () => resolve([]);
    input.click();
  });

  const SHARE_RE = /^https?:\/\/(?:www\.)?(?:alight\.link|alight\.page\.link|alightcreative\.com|www\.alightmotion\.com)\//i;
  const CANONICAL_RE = /\/am\/share\/u\/([^/]+)\/p\/([^/?#]+)/i;

  function inspectShareMeta(html, key) {
    const m = html.match(new RegExp(`<meta\\s+[^>]*property=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i'));
    return m ? m[1] : '';
  }

  window.desktop = {
    async openFile() {
      const files = await fileFromInput({ accept: '.xml,.alight,.zip,application/xml,application/zip' });
      // _"desktop.openFile returns a path; for the browser a File is just better"_
      return files.length ? files[0] : null;
    },

    async readFile(p) {
      if (p instanceof File) {
        const e = ext(p.name).toLowerCase();
        if (e === 'zip' || e === 'alight' || p.type === 'application/zip') {
          const scenes = await scenesFromZip(p);
          if (!scenes.length) throw new Error('Paket tidak berisi scene XML');
          return { scenes };
        }
        const text = await p.text();
        return { scenes: [{ name: p.name, text }] };
      }
      // string fallback: treat as a URL-ish path
      const r = await fetch(p, { redirect: 'follow' });
      if (!r.ok) throw new Error(`read-file gagal (${r.status})`);
      return { scenes: [{ name: 'remote.xml', text: await r.text() }] };
    },

    async openMedia() {
      const files = await fileFromInput({ multiple: true, accept: 'image/*,video/*,audio/*' });
      return files.map((f) => {
        const mime = f.type || mimeFor(f.name);
        return { path: null, name: f.name, mime, kind: kindFor(mime), url: URL.createObjectURL(f), size: f.size };
      });
    },

    async resolveShare(url) {
      if (!SHARE_RE.test(url)) throw new Error('URL bukan link Alight Motion yang didukung');

      // alightcreative.com sends no Access-Control-Allow-Origin, so the share
      // page can NEVER be scraped from the browser (TypeError: Failed to fetch).
      // The server does the redirect hop, og: parsing, callables and package
      // download — this side only talks to same-origin /api/share.
      const resolver = window.AM_SHARE_RESOLVER_URL || '/api/share';
      if (resolver === 'none') {
        const c = url.match(CANONICAL_RE);
        if (!c) throw new Error('Link tidak mengarah ke /am/share/u/<uid>/p/<pid>');
        return { metadata: { url, ownerId: c[1], packageId: c[2], title: 'Alight Motion package' }, requiresResolver: true };
      }

      let rr;
      try {
        rr = await fetch(`${resolver.replace(/\/$/, '')}?url=${encodeURIComponent(url)}`, {
          headers: { accept: 'application/json,application/zip,application/octet-stream' }
        });
      } catch {
        throw new Error('Server resolver tidak terjangkau — jalankan `node index.js` lalu buka lewat http://localhost:3031 (bukan file://)');
      }

      const ct = rr.headers.get('content-type') || '';
      if (!ct.includes('json')) {
        if (!rr.ok) throw new Error(`Resolver gagal (${rr.status})`);
        const scenes = await scenesFromZip(await rr.arrayBuffer());
        if (!scenes.length) throw new Error('Package tidak berisi scene XML');
        return { metadata: { url }, scenes };
      }

      const x = await rr.json();
      if (!rr.ok || !x.ok) throw new Error((x && x.error) || `Resolver gagal (${rr.status})`);
      if (!x.scenes || !x.scenes.length) throw new Error('Response resolver tidak punya scenes');
      return {
        metadata: x.metadata || {},
        manifest: x.manifest || '',
        scenes: x.scenes,
        media: x.media || {}
      };
    }
  };
})();
