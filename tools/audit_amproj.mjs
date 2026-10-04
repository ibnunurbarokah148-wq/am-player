/* audit_amproj.mjs — detektor struktur proyek AM (M7/QA).
 *
 * Baca proyek (.amproj / .xml / preset .json) LALU lapor bagian mana yang
 * AKAN HILANG saat dilempar ke pipeline kita. Ini jawaban otomatis buat
 * "preset ini aman dirender penuh nggak?" tanpa perlu buka browser.
 *
 * GAP yang dicek (sumber kebenaran: src/renderer.js flatten() + src/glscene.js):
 *
 *   [G1] embedScene  -> SELESAI sejak ccB4: flatten() kini merekursi
 *                       `embedScene` (lewat <scene> anaknya) dan menyimpan
 *                       rantai di `layer.__chain`, dievaluasi per frame di
 *                       tr(l,t,tAbs). Audit melapor "chain N" (bukan gap).
 *   [G2] group       -> SELESAI sejak ccB4: <transform> group ikut dikomposisi
 *                       lewat __chain, sama seperti embedScene.
 *   [G3] parent=     -> hierarki induk-anak AM. Transform induk tidak pernah
 *                       dikalikan ke anak => posisi salah.
 *   [G4] clippingMask-> matte AM5. Tidak ada di kode kita sama sekali.
 *   [G5] <text>      -> layer teks jalan, tapi font-nya fallback (belum ada
 *                       paket font AM di web).
 *   [G6] blending    -> nilai di luar BLEND[] di src/glscene.js:52 jatuh ke 0
 *                        (normal) — warna jadi salah, bukan crash.
 *   [G7] effect id   -> tidak ada di webfx/effects.json byId/e.file -> effect
 *                        dilewati (stats.missing).
 *   [G8] tag asing   -> tag layer yang tak dikenal whitelist sama sekali.
 *
 * Sumber-sumber ini dijaga sinkron. Kalau flatten() di renderer.js berubah,
 * ubah KEEP di sini juga. (sim_cc.mjs / sim_adjust.mjs punya konvensi sama.)
 *
 * Pakai:
 *   node tools/audit_amproj.mjs /tmp/preset_user.json /tmp/e2e2.json
 *   node tools/audit_amproj.mjs /tmp/bam/*.amproj
 *   node tools/audit_amproj.mjs others/            (semua .xml di folder)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/* ---- harus sama dengan flatten() di src/renderer.js:5 ------------------- */
const KEEP = ['shape', 'text', 'media', 'color', 'drawing'];

/* ---- harus sama dengan BLEND[] di src/glscene.js:52 --------------------- */
const BLEND = {
  '': 0, 'normal': 0, 'src': 0, 'mask-fill': 0,
  'multiply': 1, 'screen': 2,
  'add': 3, 'plus': 3, 'linear-dodge': 3, 'lighter': 3,
  'overlay': 4, 'darken': 5, 'darker-color': 5,
  'lighten': 6, 'lighter-color': 6, 'subtract': 7,
  'difference': 8, 'diff': 8, 'soft-light': 9, 'hard-light': 10,
  'color-dodge': 11, 'color-burn': 12, 'mask': 13,
  'soft-overlay': 14, 'pin-light': 15, 'linear-light': 16, 'vivid-light': 17,
  'divide': 18, 'exclusion': 19, 'exclude': 20, 'mask-exclude': 20,
  'linear-burn': 21,
  'color': 0, 'saturation': 0, 'hue': 0, 'luminance': 0, 'luminosity': 0,
};

/* tag yang memang sengaja dilewati pipeline (bukan bug) */
const SKIP_OK = /^(bookmark|audio|scene|property|transform|location|rotation|scale|opacity|fillColor|gradient|path-stroke|kf|effect|pivot|animate)$/;
/* tag "wadah" yang di dalamnya ada layer (dianggap struktur, bukan layer) */
const CONTAINER = /^(group|embedScene|precomp|nullobj)$/;

const g = (at, n) => { const r = new RegExp(n + '="([^"]*)"').exec(at); return r ? r[1] : ''; };

/* --------------------------- beban file ------------------------------- */
function xmlFrom(p) {
  if (p.endsWith('.amproj')) {
    const py = 'import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1])\nn=[x for x in z.namelist() if x.endswith(".xml")]\nsys.stdout.buffer.write(z.read(n[0]))';
    return execFileSync('python3', ['-c', py, p], { maxBuffer: 1 << 24 }).toString('utf8');
  }
  return fs.readFileSync(p, 'utf8');
}

/* preset JSON resmi AM: {metadata:{projects:[{title}]}, scenes:[{text}]} */
function scenesFrom(p) {
  const raw = fs.readFileSync(p, 'utf8');
  if (p.endsWith('.json')) {
    const j = JSON.parse(raw);
    if (Array.isArray(j.scenes)) {
      const titles = (j.metadata && j.metadata.projects || []).map((x, i) => x.title || 'scene' + i);
      return j.scenes.map((s, i) => ({ name: (titles[i] || 'scene' + i) + ' [' + path.basename(p) + ']', xml: String(s.text || s) }));
    }
    const txt = typeof j === 'string' ? j : (j.scene || j.xml || '');
    return [{ name: path.basename(p), xml: String(txt) }];
  }
  if (p.endsWith('.xml')) return [{ name: path.basename(p), xml: raw }];
  return [{ name: path.basename(p), xml: xmlFrom(p) }];
}

/* --------------------------- registry efek ---------------------------- */
function loadEffects() {
  const known = new Set();
  try {
    const j = JSON.parse(fs.readFileSync('webfx/effects.json', 'utf8'));
    for (const k of Object.keys(j.byId || {})) known.add(k);
    for (const e of (j.effects || [])) { if (e.id) known.add(e.id); if (e.file) known.add(e.file); }
  } catch (e) { console.error('!! webfx/effects.json gagal dibaca:', e.message); }
  return known;
}

/* ------------------------------ audit --------------------------------- */
function audit(name, xml, known) {
  const head = /<scene\b[^>]*>/.exec(xml);
  const attrs = head ? head[0] : '';
  const cw = +(g(attrs, 'width') || 1080), ch = +(g(attrs, 'height') || 1080);
  const body = xml.replace(/^[\s\S]*?<scene[^>]*>/, '');

  /* hitung semua tag pembuka */
  const tagN = {};
  for (const m of body.matchAll(/<([A-Za-z][\w.-]*)\b/g)) tagN[m[1]] = (tagN[m[1]] || 0) + 1;

  /* walk satu lapis buat atribut layer (blending/parent/clippingMask/label) */
  const layers = [];
  for (const k of body.matchAll(/<([a-zA-Z][\w:-]*)\b([^>]*)>([\s\S]*?)<\/\1>|<([a-zA-Z][\w:-]*)\b([^>]*)\/>/g)) {
    const tag = k[1] || k[4], at = k[2] || k[5] || '';
    if (SKIP_OK.test(tag)) continue;
    if (!/^(shape|media|text|color|drawing|group|embedScene|nullobj|precomp)$/.test(tag)) continue;
    layers.push({ tag, at, inner: k[3] || '' });
  }

  /* --- G1/G2/G8: yang dilewati flatten() --- */
  const dropped = [], containerNote = [];
  let kept = 0;
  for (const L of layers) {
    const decl = L.tag === 'media' && /\buri="/.test(L.at) && !/\bstartTime="/.test(L.at);
    if (decl) continue;                                  /* deklarasi aset, memang bukan layer */
    if (KEEP.includes(L.tag)) { kept++; continue; }
    /* G1/G2: sejak ccB4 kedua tag ini DIREKURSI + transform-nya dikomposisi.
     * Yang masih layak dilaporkan: kedalaman rantainya (chain) & jendela waktu. */
    if (L.tag === 'group' || L.tag === 'embedScene') {
      const lab = g(L.at, 'label') || g(L.at, 'id') || '?';
      const st = g(L.at, 'startTime'), en = g(L.at, 'endTime');
      const win = (st || en) ? ' jendela ' + (st || '0') + '..' + (en || 'inf') + 'ms' : '';
      containerNote.push('[chain] ' + L.tag + ' "' + lab + '"' + win + ' -> direkursi, transform diwariskan');
      continue;
    }
    dropped.push('[G8] <' + L.tag + '> tak dikenal whitelist -> HILANG');
  }

  /* --- G3 parent --- */
  const parents = [...body.matchAll(/<([a-zA-Z][\w:-]*)\b[^>]*\bparent="([^"]*)"/g)];
  /* --- G4 clippingMask --- */
  const clip = (body.match(/clippingMask="true"/g) || []).length;
  /* --- G5 teks --- */
  const texts = (tagN['text'] || 0);
  /* --- G6 blend --- */
  const blends = {}, badBlend = [];
  for (const L of layers) {
    const b = g(L.at, 'blending');
    if (!b) continue;
    blends[b] = (blends[b] || 0) + 1;
    if (!(b.toLowerCase() in BLEND)) badBlend.push(b);
  }
  /* --- G7 efek --- */
  const fxN = {}, unknown = {};
  for (const L of layers) {
    for (const m of L.inner.matchAll(/<effect\b([^>]*)\/?>/g)) {
      const id = g(m[1], 'id') || g(m[1], 'name') || '(tanpa id)';
      fxN[id] = (fxN[id] || 0) + 1;
      if (!known.has(id) && !known.has(path.posix.basename(id))) unknown[id] = (unknown[id] || 0) + 1;
    }
  }
  const fxCnt = Object.values(fxN).reduce((a, b) => a + b, 0);
  const unkCnt = Object.values(unknown).reduce((a, b) => a + b, 0);

  /* G9: deklarasi aset <media uri> yang bersarang di dalam <embedScene>/<scene>.
   * attachShareMedia() hanya membaca scene.root.children -> aset ini tak pernah
   * dipetakan saat impor share, walau layernya kini tampil (ccB4).
   * Hitung pakai kedalaman tag, bukan regex malas, biar embedScene bersarang aman. */
  let nest = 0, nestedDecl = 0, nestedMedia = 0;
  for (const m of body.matchAll(/<\/?([A-Za-z][\w.-]*)\b[^>]*?\/?>/g)) {
    const raw = m[0], tag = m[1];
    if (raw.startsWith('</')) { if (tag === 'embedScene' && nest > 0) nest--; continue; }
    if (raw.endsWith('/>')) continue;
    if (tag === 'embedScene') { nest++; continue; }
    if (nest > 0 && tag === 'media') { nestedMedia++; if (/\buri="/.test(raw)) nestedDecl++; }
  }

  const gaps = [];
  if (dropped.length) gaps.push(...dropped);
  if (nestedDecl) gaps.push('[G9] <media uri> bersarang di dalam embedScene x' + nestedDecl + ' -> attachShareMedia tak memetakannya (hanya baca scene.root.children)');
  if (parents.length) gaps.push('[G3] parent= ada di ' + parents.length + ' layer -> hierarki tak didukung (transform induk tidak diwariskan)');
  if (clip) gaps.push('[G4] clippingMask="true" x' + clip + ' -> matte AM5 belum diimplementasi');
  if (badBlend.length) gaps.push('[G6] blending tak dikenal: ' + [...new Set(badBlend)].join(', ') + ' -> jatuh ke normal(0)');
  if (unkCnt) gaps.push('[G7] effect id tak ada di webfx: ' + Object.entries(unknown).map(([k, v]) => k + '×' + v).join(', '));
  if (texts) gaps.push('[G5] <text> x' + texts + ' -> jalan tapi font fallback (paket font AM belum ada)');

  console.log(`\n##### ${name}  ${cw}×${ch}`);
  const tagStr = Object.entries(tagN).filter(([t]) => /^(shape|media|text|color|drawing|group|embedScene|audio|bookmark|nullobj)$/.test(t))
    .map(([t, n]) => t + '=' + n).join(' ');
  console.log(`  tag     : ${tagStr || '(tanpa layer)'}`);
  console.log(`  flatten : keep=${kept}  drop=${layers.filter(L => !KEEP.includes(L.tag) && !(L.tag === 'media' && /\buri="/.test(L.at) && !/\bstartTime="/.test(L.at))).length}`);
  console.log(`  efek    : ${fxCnt} instance, ${Object.keys(fxN).length} jenis, tak dikenal ${unkCnt}`);
  if (Object.keys(fxN).length && unkCnt === 0) {
    console.log('           ' + Object.entries(fxN).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => k.split('.').pop() + '×' + v).join(' '));
  }
  if (Object.keys(blends).length) console.log('  blend   : ' + Object.entries(blends).map(([k, v]) => k + '×' + v).join(' '));
  if (containerNote.length) {
    /* walk lapis-1 regex tak melihat embedScene bersarang -> laporkan juga total tagnya */
    console.log('  chain   : ' + containerNote.length + ' wadah luar (total <embedScene> = ' + (tagN['embedScene'] || 0) + ', <group> = ' + (tagN['group'] || 0) + ')');
    containerNote.forEach(x => console.log('   - ' + x));
  }
  if (nestedMedia) console.log('  media@nested: ' + nestedMedia + ' (uri=' + nestedDecl + ')');
  if (gaps.length) { console.log('  == GAP (' + gaps.length + ') =='); gaps.forEach(x => console.log('   - ' + x)); }
  else console.log('  == AMAN: tak ada gap struktural yang dikenal ==');
  return { kept, gaps: gaps.length, unkCnt, fxCnt };
}

/* ------------------------------ main ---------------------------------- */
const args = process.argv.slice(2);
if (!args.length) { console.error('pakai: node tools/audit_amproj.mjs <file...|dir...>'); process.exit(1); }
const files = [];
for (const a of args) {
  if (fs.statSync(a).isDirectory()) {
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (/\.(xml|amproj|json)$/.test(e.name)) files.push(p);
    });
    walk(a);
  } else files.push(a);
}
const known = loadEffects();
if (!known.size) { console.error('registry efek kosong — audit efek tidak akan berarti.'); }
console.log(`audit_amproj · ${files.length} file · registry efek = ${known.size} key`);
const T = { kept: 0, gaps: 0, unk: 0, fx: 0, n: 0 };
for (const f of files.sort()) {
  try {
    for (const s of scenesFrom(f)) {
      const r = audit(s.name, s.xml, known);
      T.kept += r.kept; T.gaps += r.gaps; T.unk += r.unkCnt; T.fx += r.fxCnt; T.n++;
    }
  } catch (e) { console.log(`\n##### ${f}\n  !! gagal: ${e.message}`); }
}
console.log(`\n======== TOTAL: ${T.n} scene · layer keep=${T.kept} · efek=${T.fx} · gap=${T.gaps} · efek tak dikenal=${T.unk} ========`);
