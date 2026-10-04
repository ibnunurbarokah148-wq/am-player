/* mot_probe.mjs — bukti offline: mesin `/js` (motionary) bisa baca preset kita.
 *
 * Tahap ganti engine. Sebelum menyentuh HTML/UI, kita pastikan dulu:
 *   1. js/preset.js  -> parseAMXML() nelen <scene> preset kita (model layer,
 *                       deteksi CC: copyBg / adjFx / fxLift)
 *   2. tiap efek yang dipakai preset punya file XML di /amfx (index.json)
 *   3. urutan waktu + media slot masih kebaca
 *
 *   pakai : node tools/mot_probe.mjs [file-preset.json]
 *   keluar: 0 kalau parser + coverage efek 100%
 */
import fs from 'node:fs';
import path from 'node:path';
import { DOMParser } from 'linkedom';

globalThis.DOMParser = DOMParser;

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { parseAMXML } = await import(path.join(ROOT, 'js/preset.js'));

let n = 0, fail = 0;
const ok = (c, msg) => { n++; if (!c) { fail++; console.log('  ✗ ' + msg); } else console.log('  ok  ' + msg); };

const file = process.argv[2] || '/tmp/preset_user.json';
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'webfx/effects/index.json'), 'utf8'));
const indexIds = new Set(index.effects.map(e => e.id));
const indexFiles = new Set(index.effects.map(e => e.file));
const haveFiles = new Set(fs.readdirSync(path.join(ROOT, 'webfx/effects')));

console.log(`\npreset: ${path.basename(file)}  (${pkg.scenes.length} scene)`);
console.log(`index.json: ${indexIds.size} efek · xml di disk: ${[...haveFiles].filter(f => f.endsWith('.xml')).length}\n`);

const STAT = { layers: 0, fx: 0, copyBg: 0, adjFx: 0, media: 0, text: 0, shapes: 0 };
const usedFx = new Set();
/* preset.js menyimpan id PENDEK ('tile'), amgl.js yang menerjemahkan
 * (resolveFxId): coba prefix com.alightcreative.effects./effect. + varian
 * tanpa strip. Tiru di sini supaya coverage-nya nyata. */
const shortToFull = new Map();
for (const e of index.effects) {
  shortToFull.set(e.id.replace(/^com\.alightcreative\.(effects|effect)\./, ''), e.id);
}
function resolveShort(id) {
  if (indexIds.has(id)) return id;
  const aliased = id.replace(/-/g, '');
  if (shortToFull.has(id)) return shortToFull.get(id);
  if (shortToFull.has(aliased)) return shortToFull.get(aliased);
  for (const [sh, full] of shortToFull) if (sh.replace(/-/g, '') === aliased) return full;
  return null;
}

for (let si = 0; si < pkg.scenes.length; si++) {
  const sc = pkg.scenes[si];
  const p = parseAMXML(sc.text, sc.name || ('scene' + si), sc.pkgId || null);
  console.log(`--- scene ${si}: ${p.name}`);
  console.log(`    ${p.w}x${p.h} · ${p.fps}fps · ${Math.round(p.durationMs)}ms · ${p.layers.length} layer`);
  STAT.layers += p.layers.length;
  let copyBg = 0, adjFx = 0, withFx = 0, kinds = {};
  for (const l of p.layers) {
    if (l.copyBg) copyBg++;
    if (l.adjFx) adjFx++;
    if (l.fx && l.fx.length) withFx++;
    kinds[l.type] = (kinds[l.type] || 0) + 1;
    for (const f of l.fx || []) { STAT.fx++; usedFx.add(f.id); }
    if (l.copyBg || l.adjFx) STAT.copyBg += l.copyBg ? 1 : 0, STAT.adjFx += l.adjFx ? 1 : 0;
    if (l.type === 'image' || l.type === 'video') STAT.media++;
    if (l.type === 'text') STAT.text++;
    if (l.type === 'shape') STAT.shapes++;
  }
  console.log(`    jenis: ${Object.entries(kinds).map(([k, v]) => k + '=' + v).join(' ')}`);
  console.log(`    layer ber-efek: ${withFx} · instance efek: ${[...p.layers].reduce((a, l) => a + (l.fx ? l.fx.length : 0), 0)}`);
  console.log(`    CC: copyBg(lift fill=0)=${copyBg}  adjFx(displacemap3)=${adjFx}`);
  ok(p.layers.length > 0, `scene ${si}: parser menghasilkan ${p.layers.length} layer`);
  ok(p.w > 0 && p.h > 0, `scene ${si}: dimensi ${p.w}x${p.h}`);
  ok(copyBg > 0, `scene ${si}: deteksi CC jalan (${copyBg} layer copyBg)`);
}

console.log(`\n=== efek dipakai: ${usedFx.size} jenis, ${STAT.fx} instance ===`);
const missingId = [], missingFile = [];
const rows = [];
for (const short of [...usedFx].sort()) {
  const full = resolveShort(short);
  if (!full) { missingId.push(short); rows.push(['✗', short, 'tak ada di index.json']); continue; }
  const e = index.effects.find(x => x.id === full);
  if (!haveFiles.has(e.file)) { missingFile.push(short); rows.push(['✗', short, e.file + ' FILE HILANG']); continue; }
  rows.push(['✓', short, e.file]);
}
for (const [m, id, note] of rows) console.log(`   ${m} ${id.padEnd(18)} -> ${note}`);
ok(missingId.length === 0, `semua id efek ada di index.json (hilang: ${missingId.length})`);
ok(missingFile.length === 0, `semua file XML ada di disk (hilang: ${missingFile.length})`);
ok(STAT.copyBg > 0, `total layer CC kebaca: copyBg=${STAT.copyBg} adjFx=${STAT.adjFx}`);

console.log(`\n======== ${n - fail}/${n} lulus ========`);
process.exit(fail ? 1 : 0);
