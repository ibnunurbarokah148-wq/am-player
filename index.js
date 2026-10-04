import express from 'express';
import path from 'path';
import crypto from 'crypto';
import JSZip from 'jszip';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = process.env.PORT || 3000;

const app = express();

// Serve static
app.use('/src', express.static(path.join(ROOT, 'src')));
// src/index.html uses relative URLs such as /styles.css and /renderer.js.
// Also expose the same files at the web root for the browser runtime.
app.use(express.static(path.join(ROOT, 'src')));
// Expose the bundled JSZip for the browser web-fallback shim (.zip/.alight support).
app.use('/vendor/jszip.min.js', express.static(path.join(ROOT, 'node_modules', 'jszip', 'dist', 'jszip.min.js')));
app.use('/preset', express.static(path.join(ROOT, 'preset')));
app.use('/effects', express.static(path.join(ROOT, 'effects')));
// Alight Motion effect pack: effects.json + preprocessed GLSL (tools/build_effects.py)
app.use('/webfx', express.static(path.join(ROOT, 'webfx')));
// Mesin render pihak ketiga (js/ = sumber motionary: amgl/preset/fx) — modul ES.
app.use('/js', express.static(path.join(ROOT, 'js')));
// Paket efek MENTAH Alight Motion (XML + CDATA GLSL + <script> animate()):
// inilah format yang diminta js/amgl.js -> fetch('/amfx/index.json') lalu
// fetch('/amfx/<file>'). Sumbernya folder webfx/effects yang sama.
app.use('/amfx', express.static(path.join(ROOT, 'webfx', 'effects')));

// Root → index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'src', 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '0.1.0' });
});

/* --------------------------------------------------------------------------
 * AM share-link resolver
 *
 * Ground truth from the decompiled APK (Fg/afx.java, Fg/ElementDownloadActivity):
 *   share URL  : https://alightcreative.com/am/share/u/<userId>/p/<packageId>
 *     parsed by afx.M7() -> drop(2 path segments) then [0]=="u" and [2]=="p"
 *   calls, both Firebase Cloud Functions callables via FirebaseFunctions
 *     .getHttpsCallable(name)  ->  https://<region>-<project>.cloudfunctions.net/<name>
 *     (dex template: "https://%1$s-%2$s.cloudfunctions.net/%3$s")
 *     1) getProjectMetadata      AlightLinkMetadataRequest{uid,pid,platform,appBuild,acctTestMode}
 *                                -> AlightLinkMetadataResponse{result,info,download,
 *                                   liteVersionAvailable,freeUserMaxDownloadSize,
 *                                   message,errorCode,errorMessage}
 *     2) requestProjectDownload  RequestProjectDownloadRequest{uid,pid,platform,appBuild,
 *                                   liteVersion,acctTestMode}
 *                                -> RequestProjectDownloadResponse{result,downloadUri}
 *   project id : alight-creative (resources.arsc: alight-creative.appspot.com /
 *                https://alight-creative.firebaseio.com); staging bucket is
 *                gs://alight-creative-staging.appspot.com
 *   package    : zip with a REQUIRED "manifest.txt" (MalformedSceneException when
 *                missing) + one or more *.xml scene files + IMAGE/AUDIO/VIDEO assets
 * -------------------------------------------------------------------------- */

const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const APP_BUILD = 1028425;                       // AppLovinBridge/companion appBuild constant
const PLATFORM = 'android';                      // AppLovinBridge.f61290h
const ACCOUNT_TEST_MODE = 'normal';              // "normal" when logged out
const PROJECT_ID = process.env.AM_PROJECT_ID || 'alight-creative';
const STORAGE_BUCKET = process.env.AM_STORAGE_BUCKET || `${PROJECT_ID}.appspot.com`;
// region candidates: default first, staging last. Override with AM_FUNCTIONS_BASES.
const FN_BASES = (process.env.AM_FUNCTIONS_BASES ||
  `https://us-central1-${PROJECT_ID}.cloudfunctions.net,` +
  `https://us-central1-${PROJECT_ID}-staging.cloudfunctions.net`
).split(',').map(s => s.trim()).filter(Boolean);

const T_PAGE = 15000, T_FN = 15000, T_BLOB = 60000;
// _"every fetch is capped: this box has no outbound net, hangs must fail loudly"_

const PAGE_TO = (t) => AbortSignal.timeout(t);
const SHARE_RE = /^https?:\/\/(?:www\.)?(?:alight\.link|alight\.page\.link|alightcreative\.com|www\.alightmotion\.com|alightmotion\.com)\//i;

/** follow redirects manually so we always know the canonical share URL */
async function fetchFollowing(url, headers = {}, timeout = T_PAGE) {
  let u = new URL(url);
  for (let i = 0; i < 6; i++) {
    const res = await fetch(u, {
      redirect: 'manual',
      headers: { 'user-agent': UA, ...headers },
      signal: PAGE_TO(timeout)
    });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      try { await res.arrayBuffer(); } catch { /* drain */ }
      u = new URL(loc, u);
      continue;
    }
    return { url: u.toString(), res };
  }
  throw new Error('terlalu banyak redirect saat membuka link share');
}

/** afx.M7() equivalent: /am/share/u/<uid>/p/<pid>, ';' truncates the pid */
function parseShareUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('URL tidak valid'); }
  if (!SHARE_RE.test(raw)) throw new Error('URL bukan link Alight Motion yang didukung');
  const cleaned = u.pathname.split(';')[0];      // ElementDownloadActivity cuts at ';'
  const m = cleaned.match(/\/am\/share\/u\/([^/]+)\/p\/([^/?#]+)/i);
  if (!m) throw new Error('Link tidak mengarah ke /am/share/u/<uid>/p/<pid>');
  return { userId: decodeURIComponent(m[1]), packageId: decodeURIComponent(m[2]) };
}

/** Firebase callable wire protocol: {"data": payload} -> {"result": value} */
async function callable(fn, payload) {
  const body = JSON.stringify({ data: payload });
  let lastErr = null;
  for (const base of FN_BASES) {
    try {
      const res = await fetch(`${base}/${fn}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          // the Android SDK always sends this; some functions reject without it
          'x-firebase-client': 'firebase-android-sdk/24.10.0 firebase-functions/1.0'
        },
        body,
        signal: PAGE_TO(T_FN)
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      if (json && json.error) {
        throw new Error(`${fn}: ${JSON.stringify(json.error).slice(0, 300)}`);
      }
      if (!res.ok) {
        throw new Error(`${fn}: HTTP ${res.status} ${text.slice(0, 200)}`);
      }
      if (!json || !('result' in json)) {
        throw new Error(`${fn}: respons tanpa field 'result' (${text.slice(0, 200)})`);
      }
      return json.result;
    } catch (e) {
      lastErr = e;                                  // wrong region / App Check / no net
    }
  }
  throw lastErr || new Error(`${fn}: semua endpoint gagal`);
}

/** gs://bucket/obj | bare storage path | absolute https -> fetchable URL */
function storageUrl(ref) {
  if (!ref) return null;
  if (/^https?:\/\//i.test(ref)) return ref;
  const gs = ref.match(/^gs:\/\/([^/]+)\/(.+)$/i);
  const bucket = gs ? gs[1] : STORAGE_BUCKET;
  const obj = gs ? gs[2] : String(ref).replace(/^\/+/, '');
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(obj)}?alt=media`;
}

/* --- direct package download ---------------------------------------------
 * getProjectMetadata happily answers for a free account, but
 * requestProjectDownload refuses any package over 5 MB
 * ("A subscription is required ...", download === "sub-required-size") and the
 * callable then 500s. The package object itself, however, is world-readable on
 * the bucket at share/<uid>/p/<pid>/<name> with no token — so we read it there
 * first and only fall back to the callable when the object is really absent.
 * ------------------------------------------------------------------------ */
const PKG_NAMES = ['projectfiles.zip', 'projectFiles.zip', 'package.zip', 'project.zip'];
// object path mirrors the thumbnail URLs published in og:image:
//   share/u/<uid>/p/<pid>/<name>   (note the literal "u" segment)
const objectUrlFor = (uid, pid, name) =>
  `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/` +
  `${encodeURIComponent(`share/u/${uid}/p/${pid}/${name}`)}?alt=media`;

/** size + md5 without pulling the body (GCS sends md5 in x-goog-hash) */
async function headObject(url) {
  const r = await fetch(url, {
    method: 'HEAD',
    headers: { 'user-agent': UA },
    signal: PAGE_TO(T_PAGE)
  });
  if (!r.ok) return null;
  const len = Number(r.headers.get('content-length') || 0);
  const hash = r.headers.get('x-goog-hash') || '';
  const m = hash.match(/md5=([^;,\s]+)/);
  return { len, md5b64: m ? m[1] : null };
}

/**
 * Range-download in 4 MB slices. A plain GET over this link silently stops
 * mid-body while still reporting 200 (observed: 22 MB of 50 MB), so every slice
 * is fetched separately, retried, and hashed as it lands.
 */
async function downloadRanged(url, total, expectMd5b64, tag) {
  const CHUNK = 4 * 1024 * 1024;
  const parts = [];
  const hash = crypto.createHash('md5');
  let got = 0, misses = 0, limit = total || 0;

  while (!limit || got < limit) {
    const end = limit ? Math.min(got + CHUNK - 1, limit - 1) : got + CHUNK - 1;
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': UA, 'accept-encoding': 'identity', range: `bytes=${got}-${end}` },
        signal: PAGE_TO(T_BLOB)
      });
      if (r.status === 200) {
        // server ignored the Range header -> this body is the whole object
        const buf = Buffer.from(await r.arrayBuffer());
        hash.update(buf);
        parts.push(buf);
        got = buf.length;
        limit = got;
        break;
      }
      if (r.status !== 206) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) throw new Error('chunk kosong');
      hash.update(buf);
      parts.push(buf);
      got += buf.length;
      misses = 0;
      if (got % (CHUNK * 4) < CHUNK) console.log(`  [share] ${tag} ${Math.round(got * 100 / (limit || got))}% (${got}/${limit || '?'} )`);
    } catch (e) {
      if (++misses > 8) throw new Error(`download putus di ${got} byte: ${e.message}`);
      console.log(`  [share] ${tag} retry ${misses} @${got}: ${e.message}`);
    }
  }

  const buf = Buffer.concat(parts, got);
  if (expectMd5b64) {
    const gotMd5 = hash.digest('base64');
    if (gotMd5 !== expectMd5b64) {
      throw new Error(`md5 tidak cocok (dapat ${gotMd5}, harap ${expectMd5b64})`);
    }
  }
  return buf;
}

/** try every known object name; null when none of them exist */
async function tryDirectPackage(uid, pid) {
  for (const name of PKG_NAMES) {
    const url = objectUrlFor(uid, pid, name);
    let info = null;
    try {
      const r = await fetch(url, { method: 'HEAD', headers: { 'user-agent': UA }, signal: PAGE_TO(T_PAGE) });
      if (r.ok) info = { len: Number(r.headers.get('content-length') || 0), md5b64: (r.headers.get('x-goog-hash') || '').match(/md5=([^;,\s]+)/)?.[1] || null };
      else console.log(`  [share] HEAD ${name} -> ${r.status} ${url}`);
    } catch (e) {
      console.log(`  [share] HEAD ${name} gagal: ${e.message}`);
    }
    if (!info || !info.len) continue;
    console.log(`  [share] objek langsung ${name} (${info.len} byte, md5 ${info.md5b64 || '-'})`);
    const buf = await downloadRanged(url, info.len, info.md5b64, name);
    if (buf[0] === 0x50 && buf[1] === 0x4b) return { buf, source: `storage:${name}` };
    console.log(`  [share] ${name} bukan zip, lanjut nama berikutnya`);
  }
  return null;
}


const og = (html, key) =>
  (html.match(new RegExp(`<meta\\s+[^>]*property=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i')) || [])[1] || '';

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'mov', 'mkv']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac']);
const kindOf = (n) => {
  const e = String(n).split('.').pop().toLowerCase();
  if (IMAGE_EXT.has(e)) return 'image';
  if (VIDEO_EXT.has(e)) return 'video';
  if (AUDIO_EXT.has(e)) return 'audio';
  return null;
};
const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', bmp: 'image/bmp',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
  xml: 'application/xml', txt: 'text/plain; charset=utf-8'
};
const mimeOf = (n) => MIME[String(n).split('.').pop().toLowerCase()] || 'application/octet-stream';

// unpacked packages served from memory; URL is handed back to the browser so
// fillImage/fillVideo/src attributes inside the scene can resolve their assets.
const PKG = new Map();  // token -> { zip, expires }
const PKG_TTL = 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of PKG) if (v.expires < now) PKG.delete(k);
}, 10 * 60 * 1000).unref?.();

/** one full share-link resolution: page metadata -> callable -> zip -> scenes */
async function resolveShare(rawUrl) {
  if (!SHARE_RE.test(rawUrl)) throw new Error('URL bukan link Alight Motion yang didukung');

  // canonical link -> straight to the callables; shortlinks need one redirect hop
  let finalUrl = rawUrl, html = '', userId = null, packageId = null;
  try {
    ({ userId, packageId } = parseShareUrl(rawUrl));
    finalUrl = rawUrl;
  } catch {
    const hop = await fetchFollowing(rawUrl);
    finalUrl = hop.url;
    ({ userId, packageId } = parseShareUrl(finalUrl));
    try {
      if (hop.res && hop.res.ok) html = await hop.res.text();   // og: fallback only
    } catch { /* best effort */ }
  }

  // 1) getProjectMetadata
  const meta = await callable('getProjectMetadata', {
    uid: userId, pid: packageId, platform: PLATFORM, appBuild: APP_BUILD, acctTestMode: ACCOUNT_TEST_MODE
  });
  if (!meta || meta.result !== 'success' || !meta.info) {
    throw new Error(`getProjectMetadata gagal: ${meta && (meta.errorCode || meta.errorMessage || meta.message) || JSON.stringify(meta).slice(0, 240)}`);
  }
  const info = meta.info;

  // 2) package bytes. Direct object first: requestProjectDownload answers
  //    "A subscription is required to download project packages over 5 MB"
  //    (download === "sub-required-size") and then 500s for a free account.
  let buf = null, source = '', dlNote = '';

  const direct = await tryDirectPackage(userId, packageId);
  if (direct) { buf = direct.buf; source = direct.source; }

  if (!buf) {
    let target = null;
    try {
      const dl = await callable('requestProjectDownload', {
        uid: userId, pid: packageId, platform: PLATFORM, appBuild: APP_BUILD,
        liteVersion: false, acctTestMode: ACCOUNT_TEST_MODE
      });
      if (dl && dl.downloadUri) target = dl.downloadUri;
      else dlNote = `requestProjectDownload tanpa downloadUri: ${JSON.stringify(dl).slice(0, 200)}`;
    } catch (e) {
      dlNote = e.message;
    }
    // meta.download carries a reason code ("sub-required-size"), never a path —
    // only trust it when it actually looks like one.
    if (!target && typeof meta.download === 'string' && /^(https?:\/\/|gs:\/\/|\/)/i.test(meta.download)) {
      target = meta.download;
    }
    if (!target) throw new Error(`tidak ada URL package (${dlNote || 'metadata.download kosong'})`);

    const targetUrl = storageUrl(target);
    let head = null;
    try { head = await headObject(targetUrl); } catch { head = null; }
    if (head && head.len) {
      buf = await downloadRanged(targetUrl, head.len, head.md5b64, 'callable');
    } else {
      const { res: blob } = await fetchFollowing(targetUrl, {}, T_BLOB);
      if (!blob.ok) throw new Error(`download package gagal (${blob.status}) ${targetUrl}`);
      buf = Buffer.from(await blob.arrayBuffer());
    }
    source = 'callable';
  }
  if (!buf.length) throw new Error('download package kosong');

  // metadata we can surface without the page (og: only as a fallback)
  const metadata = {
    url: finalUrl, ownerId: userId, packageId,
    title: info.title || og(html, 'og:title') || 'Alight Motion package',
    thumbnail: info.largeThumbUrl || info.medThumbUrl || og(html, 'og:image') || '',
    description: og(html, 'og:description') || og(html, 'description') || '',
    projectCount: Array.isArray(info.projects) ? info.projects.length : 0,
    projects: (info.projects || []).map(p => ({ title: p.title, size: p.size, type: p.type })),
    size: info.size || 0,
    amVersionCode: info.amVersionCode || 0,
    amVersionString: info.amVersionString || '',
    amPlatform: info.amPlatform || '',
    shortLink: info.shortLink || '',
    shareDate: info.shareDate || null,
    requiredEffects: info.requiredEffects || [],
    unavailableNotice: info.unavailableNotice || null
  };

  // 4) unpack
  const packed = await unpackPackage(buf, source);
  console.log(`  [share] selesai via ${source}: ${packed.scenes.length} scene, ${Object.keys(packed.media).length} aset`);
  // _"the scene text carries content:// and relative refs; media URLs patch them back up"_
  return { metadata: { ...metadata, source }, ...packed };
}

/** raw package bytes -> {manifest, scenes:[{name,text}], media:{path:url}} */
async function unpackPackage(buf, targetUrl = '') {
  const head = buf.slice(0, 512).toString('utf8').replace(/^\uFEFF/, '').trim();
  if (head.startsWith('<')) {
    // some links resolve straight to a scene document instead of a zip
    return { manifest: '', scenes: [{ name: 'share', text: buf.toString('utf8') }], media: {} };
  }
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) {      // "PK"
    throw new Error(`package bukan zip (header ${buf.slice(0, 8).toString('hex')}${targetUrl ? ' ' + targetUrl : ''})`);
  }

  const zip = await JSZip.loadAsync(buf);
  const mf = zip.file('manifest.txt');
  const hasManifest = !!mf;
  const manifest = mf ? await mf.async('string') : '';
  const scenes = [];
  const mediaPaths = [];
  for (const f of Object.values(zip.files)) {
    if (f.dir) continue;
    const name = f.name.replace(/^\.\//, '');
    if (/\.xml$/i.test(name)) {
      const text = await f.async('string');
      if (/<scene[\s>]/.test(text)) scenes.push({ name: name.replace(/^.*\//, '').replace(/\.xml$/i, ''), text });
    } else if (!/^manifest\.txt$/i.test(name) && kindOf(name)) {
      mediaPaths.push(name);
    }
  }
  if (!scenes.length) {
    const where = hasManifest
      ? (manifest.trim() ? `${manifest.split('\n').length} baris manifest, nol <scene>` : 'manifest.txt kosong')
      : 'manifest.txt hilang';
    throw new Error(`paket tidak berisi <scene> XML (${where})`);
  }

  const token = crypto.randomBytes(9).toString('base64url');
  PKG.set(token, { zip, expires: Date.now() + PKG_TTL });
  const media = {};
  for (const n of mediaPaths) media[n] = `/api/share/pkg/${token}/${n}`;
  return { manifest, scenes, media };
}

// GET /api/share?url=... -> {ok, metadata, manifest, scenes, media}
app.get('/api/share', async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!url) return res.status(400).json({ ok: false, error: 'parameter ?url= wajib' });
  try {
    const out = await resolveShare(url);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message || String(e) });
  }
});

// GET /api/share/pkg/<token>/<entry> -> raw asset from an unpacked package
app.get('/api/share/pkg/:token/*', async (req, res) => {
  const entry = decodeURIComponent(req.params[0] || '');
  const pkg = PKG.get(req.params.token);
  if (!pkg || pkg.expires < Date.now()) {
    return res.status(410).json({ ok: false, error: 'paket sudah kedaluwarsa; buka ulang link share' });
  }
  if (!entry || entry.includes('..') || entry.startsWith('/')) {
    return res.status(400).json({ ok: false, error: 'nama entry tidak valid' });
  }
  const file = pkg.zip.file(entry) || pkg.zip.file(entry.replace(/^\.\//, ''));
  if (!file) return res.status(404).json({ ok: false, error: `entry tidak ada: ${entry}` });
  try {
    const data = await file.async('nodebuffer');
    res.set({
      'content-type': mimeOf(entry),
      'content-length': String(data.length),
      'cache-control': 'private, max-age=3600'
    });
    res.end(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// exported for offline tests (tools/test-share.mjs sets AM_NO_LISTEN=1)
export { parseShareUrl, storageUrl, unpackPackage, callable, resolveShare };

if (!process.env.AM_NO_LISTEN) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 Server running at:');
    console.log('   http://localhost:' + PORT);
    console.log('   share resolver: /api/share?url=<alight link>');
    console.log('   functions: ' + FN_BASES.join(', '));
  });
}
