/* tools/test-share.mjs — offline verification for the AM share resolver.
 *
 * Runs everything EXCEPT the two Firebase callables (this box has no outbound
 * network). Imports index.js on PORT=3099 so unpackPackage() and the
 * /api/share/pkg/<token>/<entry> route share one PKG map, i.e. the asset
 * serving is tested for real, not mocked.
 *
 *   node tools/test-share.mjs
 */
import JSZip from 'jszip';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
};
const throws = (fn, needle, label) => {
  try { fn(); fail++; console.log(`  FAIL ${label} (tidak melempar error)`); }
  catch (e) {
    const m = String(e.message);
    const hit = needle.every(n => m.includes(n));
    if (hit) { pass++; console.log(`  ok   ${label} -> "${m.slice(0, 90)}"`); }
    else { fail++; console.log(`  FAIL ${label} -> "${m.slice(0, 120)}" (butuh ${JSON.stringify(needle)})`); }
  }
};
const throwsAsync = async (fn, needle, label) => {
  try { await fn(); fail++; console.log(`  FAIL ${label} (tidak melempar error)`); }
  catch (e) {
    const m = String(e.message);
    const hit = needle.every(n => m.includes(n));
    if (hit) { pass++; console.log(`  ok   ${label} -> "${m.slice(0, 90)}"`); }
    else { fail++; console.log(`  FAIL ${label} -> "${m.slice(0, 120)}" (butuh ${JSON.stringify(needle)})`); }
  }
};

process.env.PORT = process.env.PORT || '3099';
const BASE = `http://127.0.0.1:${process.env.PORT}`;

// index.js also starts the HTTP server here (no AM_NO_LISTEN) so the asset
// route can be exercised against the same PKG map unpackPackage() fills.
const { parseShareUrl, storageUrl, unpackPackage } = await import('../index.js');

for (let i = 0; i < 40; i++) {
  try { const r = await fetch(`${BASE}/health`); if (r.ok) break; } catch { /* not up yet */ }
  await new Promise(r => setTimeout(r, 150));
}

console.log('\n[1] parseShareUrl — must mirror afx.M7(): drop 2 segments, [0]=="u", [2]=="p"');
{
  const a = parseShareUrl('https://alightcreative.com/am/share/u/u_9f3kaZx/p/pk_7dQm12');
  ok(a.userId === 'u_9f3kaZx' && a.packageId === 'pk_7dQm12', 'canonical /u/<uid>/p/<pid>', JSON.stringify(a));

  const b = parseShareUrl('http://alightcreative.com/am/share/u/u_x/p/p_y;fbclid=abc');
  ok(b.userId === 'u_x' && b.packageId === 'p_y', "';' memotong packageId (ElementDownloadActivity)");

  const c = parseShareUrl('https://www.alightmotion.com/am/share/u/a%20b/p/c%2Fd');
  ok(c.userId === 'a b' && c.packageId === 'c/d', 'URL-decode segmen');

  // shortlink harus melempar; resolveShare() menangkap ini lalu ikuti redirect
  throws(() => parseShareUrl('https://alight.link/AbC123'), ['tidak mengarah'], 'shortlink ditolak sini (hop dilakukan resolveShare)');

  throws(() => parseShareUrl('https://alightcreative.com/foo/bar'), ['tidak mengarah'], 'path salah');
  throws(() => parseShareUrl('https://example.com/am/share/u/1/p/2'), ['didukung'], 'host salah');
}

console.log('\n[2] storageUrl — gs:// | bare path | https');
{
  ok(storageUrl('https://cdn.example.com/x.zip') === 'https://cdn.example.com/x.zip', 'https dipasrahkan');
  ok(storageUrl('gs://alight-creative.appspot.com/projects/a.zip')
    === 'https://firebasestorage.googleapis.com/v0/b/alight-creative.appspot.com/o/projects%2Fa.zip?alt=media',
    'gs:// -> firebasestorage REST');
  ok(storageUrl('projects/u/p/pk_1/pkg.zip')
    === 'https://firebasestorage.googleapis.com/v0/b/alight-creative.appspot.com/o/projects%2Fu%2Fp%2Fpk_1%2Fpkg.zip?alt=media',
    'bare path memakai bucket default alight-creative');
  ok(storageUrl(null) === null, 'null -> null');
}

console.log('\n[3] unpackPackage — *.xml = scene, aset = media, manifest dibaca (opsional)');
const SCENE = `<?xml version="1.0" encoding="utf-8"?>
<scene width="1080" height="1920" fps="30" totalTime="4000" title="Uji Share" amver="5.0.0">
  <shape id="1" label="bg" startTime="0" endTime="4000" fillImage="images/bg.png" size="1080,1920"/>
  <shape id="2" label="vid" startTime="0" endTime="4000" fillVideo="video/clip.mp4" size="1080,1920"/>
  <audio id="3" label="voice.mp3" startTime="0" endTime="4000" src="audio/voice.mp3"/>
</scene>`;
const NON_SCENE = `<?xml version="1.0"?><project><meta/></project>`;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
const MP3 = Buffer.from('fff344c000000000000000000000000000000000', 'hex');

const makeZip = async (entries) => {
  const z = new JSZip();
  for (const [name, data] of entries) z.file(name, data);
  return z.generateAsync({ type: 'nodebuffer' });
};

let unpacked, mediaUrl = null;
{
  const buf = await makeZip([
    ['manifest.txt', 'scene0.xml\thash=abc\nimages/bg.png\nvideo/clip.mp4\naudio/voice.mp3\n'],
    ['scene0.xml', SCENE],
    ['extra/notes.xml', NON_SCENE],          // xml tanpa <scene> -> dilewati
    ['images/bg.png', PNG],
    ['video/clip.mp4', MP3],
    ['audio/voice.mp3', MP3],
    ['fonts/custom.ttf', Buffer.from('OTTO')] // bukan media -> tidak diekspos
  ]);
  unpacked = await unpackPackage(buf, 'test://synthetic.zip');

  ok(unpacked.manifest.includes('scene0.xml'), 'manifest.txt terbaca');
  ok(unpacked.scenes.length === 1, `tepat 1 scene (dapat ${unpacked.scenes.length})`);
  ok(unpacked.scenes[0].name === 'scene0', 'nama scene dari nama file');
  ok(unpacked.scenes[0].text.includes('fillImage="images/bg.png"'), 'teks scene utuh');
  ok(unpacked.media['images/bg.png'] && unpacked.media['video/clip.mp4'] && unpacked.media['audio/voice.mp3'],
    '3 aset media diekspos', JSON.stringify(Object.keys(unpacked.media)));
  ok(!Object.keys(unpacked.media).some(k => k.endsWith('.ttf')), 'font .ttf tidak ikut media');
  ok(!Object.keys(unpacked.media).some(k => k === 'manifest.txt'), 'manifest.txt tidak ikut media');
  ok(unpacked.media['images/bg.png'].startsWith('/api/share/pkg/'), 'URL media memakai /api/share/pkg/<token>/', unpacked.media['images/bg.png']);
  mediaUrl = unpacked.media['images/bg.png'];
}

console.log('\n[4] jalur error unpack');
await throwsAsync(() => unpackPackage(Buffer.from('bukan-zip-sama-sekali-XYZ')), ['bukan zip'], 'bukan zip ditolak');
// APK melempar MalformedSceneException("Project package missing manifest"),
// tapi manifest.txt dipakai cuma untuk verifikasi hash — dan kita tidak
// memverifikasi hash. Menolaknya hanya memblokir import yang sebenarnya bisa
// jalan, jadi sengaja dilonggarkan.
{
  const noManifest = await unpackPackage(await makeZip([['scene0.xml', SCENE]]));
  ok(noManifest.scenes.length === 1 && noManifest.manifest === '',
    'zip TANPA manifest.txt tetap diterima (deviasi sadar dari AM: tanpa cek hash)');
}
await throwsAsync(async () => unpackPackage(await makeZip([
  ['manifest.txt', ''],
  ['notes.xml', NON_SCENE],
  ['readme.txt', 'nope']
])), ['tidak berisi <scene>'], 'zip tanpa <scene> ditolak');
{
  const raw = await unpackPackage(Buffer.from(SCENE, 'utf8'));
  ok(raw.scenes.length === 1 && raw.scenes[0].name === 'share', 'payload mentah XML (bukan zip) diterima');
}

console.log('\n[5] route /api/share/pkg/<token>/<entry> (server beneran, PKG satu process)');
{
  const r = await fetch(`${BASE}${mediaUrl}`);
  const buf = Buffer.from(await r.arrayBuffer());
  ok(r.status === 200, `aset 200 (dapat ${r.status})`);
  ok((r.headers.get('content-type') || '').startsWith('image/png'), `content-type png (dapat ${r.headers.get('content-type')})`);
  ok(buf.equals(PNG), 'isi byte persis seperti di zip');

  const mp3 = await fetch(`${BASE}${unpacked.media['audio/voice.mp3']}`);
  ok(mp3.status === 200 && (mp3.headers.get('content-type') || '').startsWith('audio/mpeg'), 'audio mpeg');

  const bad = await fetch(`${BASE}/api/share/pkg/AAAAAAAAAAAAAAA/../../index.js`);
  ok(bad.status === 400 || bad.status === 404, `path traversal diblokir (${bad.status})`);

  const gone = await fetch(`${BASE}/api/share/pkg/tidakada/x.png`);
  ok(gone.status === 410, `token tak dikenal -> 410 (${gone.status})`);
}

console.log(`\n${fail === 0 ? 'SEMUA LULUS' : 'ADA GAGAL'} — ${pass} ok, ${fail} fail\n`);
process.exit(fail === 0 ? 0 : 1);
