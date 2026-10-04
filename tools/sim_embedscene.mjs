/* sim_embedscene.mjs — uji rantai <embedScene>/<group> (ccB4).
 *
 * BEDA dari sim_cc/sim_adjust: dua tool itu MENIRU logika (harus disinkron).
 * Ini MENGAMBIL fungsi ASLI dari src/renderer.js (flatten, tr, mMul, mTRS,
 * mInv, value, attr, num, vec, clamp) lewat pemotongan sumber + brace matching,
 * lalu mengeksekusinya di vm Node dengan DOM beneran (linkedom). Jadi kalau
 * flatten/tr salah, tes ini ikut salah — bukan tes terhadap salinan.
 *
 * Yang divalidasi:
 *   [A] aljabar affine  : komposisi 2 level  == kalikan matriksnya manual
 *   [B] urutan rantai   : M_luar * M_dalam * M_layer (kiri * kanan)
 *   [C] gating waktu    : anak mati sebelum startTime induk, hidup sesudahnya
 *   [D] gm.amproj       : nesting 5 level, rantai ke-shape terdalam == 5
 *   [E] preset user     : scene1 sekarang punya layer bersarang + Group 4
 *                          (id 205153674, startTime 1633) tak terlihat < 1633ms
 *
 * Pakai:  node tools/sim_embedscene.mjs
 * Keluar 0 kalau semua klaim lolos, 1 kalau ada yang gagal.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { DOMParser } from 'linkedom';

const SRC = fs.readFileSync('src/renderer.js', 'utf8');
let fail = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) fail++; };
const num4 = n => (Math.round(n * 1000) / 1000).toString();
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

/* ---------------- ekstraksi fungsi asli dari src/renderer.js ---------------- */
function grabFunction(name) {
  const at = SRC.indexOf('function ' + name + '(');
  if (at < 0) throw Error('fungsi tak ketemu: ' + name);
  const open = SRC.indexOf('{', at);
  let d = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === '{') d++;
    else if (SRC[i] === '}') { d--; if (!d) return SRC.slice(at, i + 1); }
  }
  throw Error('tutup kurung tak ketemu: ' + name);
}
function grabConst(name) {
  const at = SRC.indexOf('const ' + name + '=');
  if (at < 0) throw Error('const tak ketemu: ' + name);
  let d = 0;
  for (let i = at; i < SRC.length; i++) {
    const c = SRC[i];
    if ('([{'.includes(c)) d++;
    else if (')]}'.includes(c)) { d--; if (d === 0 && c === ']') { /* tetap cari ; */ } }
    else if (c === ';' && d === 0) return SRC.slice(at, i + 1);
  }
  throw Error('; tak ketemu: ' + name);
}
function grabPrelude() {
  const line = SRC.split('\n').find(l => l.startsWith('const clamp='));
  if (!line) throw Error('baris prelude clamp/num/attr/vec tak ketemu');
  return line;
}

const CODE = [
  grabPrelude(),
  /* rantai easing — value() memanggil easeQ() saat <kf> punya e="cubicBezier ..." */
  grabFunction('bezier'),
  grabConst('easeWarned'),
  grabFunction('easeBezier'),
  grabFunction('easeElastic'),
  grabFunction('easeCyclic'),
  grabFunction('easeFn'),
  grabFunction('easeQ'),
  grabFunction('value'),
  grabConst('mMul'),
  grabFunction('mTRS'),
  grabFunction('mInv'),
  grabFunction('flatten'),
  grabFunction('tr'),
].join('\n');

const sandbox = { console, Math, Number, String, Array, Object, JSON, Error, scene: null };
vm.createContext(sandbox);
vm.runInContext(CODE, sandbox, { filename: 'renderer.js#extract' });
/* catatan vm: `function` di top-level jadi properti global, tapi `const`
 * (mMul) cuma hidup di lexical environment context -> ambil lewat evaluasi. */
const api = vm.runInContext('({flatten, tr, mMul, mTRS, mInv})', sandbox);
const { flatten, tr, mMul, mTRS, mInv } = api;
if (typeof flatten !== 'function' || typeof tr !== 'function' || typeof mMul !== 'function') {
  console.error('gagal mengekstrak flatten/tr dari src/renderer.js'); process.exit(1);
}
console.log('extract: flatten, tr, mMul, mTRS, mInv, value + rantai easing (bezier/easeFn/easeQ)  [OK]');

/* ------------------------- pembaca XML ------------------------- */
function parseXML(text) {
  const d = new DOMParser().parseFromString(text, 'text/xml');
  if (d.querySelector('parsererror')) throw Error('XML rusak');
  return d.documentElement;
}
const sceneOf = (root, dur) => ({
  root, duration: dur,
  w: Number(root.getAttribute('width') || 1080),
  h: Number(root.getAttribute('height') || 1920),
});

/* =========================================================================
 * [A] + [B] aljabar & urutan rantai — fixture sintetis, ekspektasi tertulis tangan
 * ======================================================================= */
console.log('\n== [A][B] aljabar affine + urutan rantai ==');
{
  const xml = `<scene width="1000" height="1000" totalTime="1000">
    <embedScene id="outer">
      <transform><location value="100,0"/><scale value="2,2"/></transform>
      <scene>
        <shape id="leaf" label="leaf"><transform><location value="0,50"/></transform>
          <fillColor value="#ffffffff"/><property name="size" type="vec2" value="10,10"/></shape>
      </scene>
    </embedScene>
  </scene>`;
  const root = parseXML(xml);
  sandbox.scene = sceneOf(root, 1000);
  const layers = flatten(root);
  ok(layers.length === 1 && layers[0].getAttribute('id') === 'leaf', 'flatten menemukan 1 layer bersarang (dapat ' + layers.length + ')');
  ok(Array.isArray(layers[0].__chain) && layers[0].__chain.length === 1, 'layer punya __chain sepanjang 1');

  const q = tr(layers[0], 0, 0);
  /* manual: Mouter = T(100,0)*S(2,2) = [2,0,0,2,100,0]
   * Mleaf   = T(0,50)                 = [1,0,0,1,0,50]
   * total   = Mouter*Mleaf            = [2,0,0,2, 100, 100]  */
  const manual = mMul([2, 0, 0, 2, 100, 0], [1, 0, 0, 1, 0, 50]);
  ok(q.m.every((v, i) => near(v, manual[i])), 'q.m == manual Mouter*Mleaf  -> [' + q.m.map(num4) + ']');
  ok(near(q.m[4], 100) && near(q.m[5], 100), 'pusat layer -> (100,100): scale 2 induk menerapkan lokasi anak 0,50 jadi 0,100');
  ok(near(q.m[0], 2) && near(q.m[3], 2), 'skala induk 2 terwarisi');

  /* urutan salah (anak dulu, induk belakangan) HARUS beda -> bukti urutan penting */
  const wrong = mMul([1, 0, 0, 1, 0, 50], [2, 0, 0, 2, 100, 0]);
  ok(!near(wrong[4], q.m[4]) || !near(wrong[5], q.m[5]), 'urutan terbalik berbeda ([' + wrong.map(num4) + ']) — urutan kiri*kanan memang berpengaruh');

  /* mInv() -> mat3 kolom-major [a,b,0, c,d,0, e,f,1] buat GLSL uInv.
   * Verifikasi: M3 * I3 == identitas, dan dunia->lokal membalik dengan benar. */
  const m = q.m, I = mInv(m);
  const toM3 = v => [v[0], v[1], 0, v[2], v[3], 0, v[4], v[5], 1];
  const M3 = toM3(m);
  const mul3 = (A, B) => { const r = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) r[j * 3 + i] += A[k * 3 + i] * B[j * 3 + k];
    return r; };
  const P = mul3(M3, I);
  const ident = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  ok(P.every((v, i) => near(v, ident[i], 1e-5)),
     'mInv: M3 * M3^-1 == identitas -> [' + P.map(num4).join(',') + ']');
  /* pusat layer (0,0,1) -> dunia -> balik ke lokal (0,0) */
  const wx = m[4], wy = m[5];
  const bx = I[0] * wx + I[3] * wy + I[6], by = I[1] * wx + I[4] * wy + I[7];
  ok(near(bx, 0, 1e-5) && near(by, 0, 1e-5), 'mInv memetakan pusat layer kembali ke 0,0 (dapat ' + num4(bx) + ',' + num4(by) + ')');
}

/* =========================================================================
 * [C] gating waktu + opacity induk
 * ======================================================================= */
console.log('\n== [C] gating jendela waktu induk ==');
{
  const xml = `<scene width="800" height="600" totalTime="3000">
    <embedScene id="late" startTime="1633" endTime="2699">
      <transform><location value="10,20"/><opacity value="0.5"/></transform>
      <scene>
        <shape id="kid"><transform><location value="1,1"/></transform>
          <fillColor value="#ffffffff"/><property name="size" type="vec2" value="4,4"/></shape>
      </scene>
    </embedScene>
  </scene>`;
  const root = parseXML(xml);
  sandbox.scene = sceneOf(root, 3000);
  const kid = flatten(root)[0];

  ok(tr(kid, 0, 500).ok === false, 't=500ms  -> ok=false (sebelum startTime 1633)');
  ok(tr(kid, 0, 1633).ok === true,  't=1633ms -> ok=true  (masuk jendela)');
  ok(tr(kid, 0, 2699).ok === true,  't=2699ms -> ok=true  (batas akhir inclusive)');
  ok(tr(kid, 0, 2700).ok === false, 't=2700ms -> ok=false (setelah endTime)');

  const q = tr(kid, 0, 2000);
  ok(near(q.mop, 0.5), 'q.mop = opacity induk 0.5 x layer 1.0 -> ' + num4(q.mop));
  ok(q.nch === 1, 'q.nch = 1 (satu induk)');
  ok(near(q.m[4], 11) && near(q.m[5], 21), 'pusat = induk(10,20)+anak(1,1) -> (11,21)');

  /* tanpa tAbs: gating dilewati tapi komposisi tetap jalan (kontrak tr) */
  const q2 = tr(kid, 0);
  ok(q2.ok === true && near(q2.m[4], 11), 'tanpa tAbs -> tanpa gating, komposisi tetap (m=' + num4(q2.m[4]) + ')');
}

/* =========================================================================
 * [D] gm.amproj — nesting 5 level nyata dari korpus referensi
 * ======================================================================= */
console.log('\n== [D] gm.amproj: nesting 5 level ==');
function xmlFromAmproj(p) {
  const py = 'import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1])\nn=[x for x in z.namelist() if x.endswith(".xml")]\nsys.stdout.buffer.write(z.read(n[0]))';
  return execFileSync('python3', ['-c', py, p], { maxBuffer: 1 << 24 }).toString('utf8');
}
{
  const xml = xmlFromAmproj('/tmp/opencode/bam/gm.amproj');
  const root = parseXML(xml);
  sandbox.scene = sceneOf(root, Number(root.getAttribute('totalTime') || 2000));
  const layers = flatten(root);
  console.log('  layer hasil flatten: ' + layers.length + ' -> ' +
    layers.map(l => (l.getAttribute('label') || l.tagName) + '(chain' + (l.__chain ? l.__chain.length : 0) + ')').join(', '));
  ok(layers.length >= 2, 'ada layer terambil (dapat ' + layers.length + ')');
  const depths = layers.map(l => (l.__chain ? l.__chain.length : 0)).sort((a, b) => a - b);
  ok(depths.join(',') === '1,2,3,4,5',
     'tiap level punya shape sendiri -> kedalaman rantai {1,2,3,4,5} (dapat {' + depths.join(',') + '})');
  ok(Math.max(...depths) === 5, 'kedalaman maksimum == 5 = kedalaman <embedScene> di file');
  ok(depths.every(d => d > 0), 'tidak ada layer yang jatuh tanpa rantai (dalam wadah)');
  const deepest = layers.find(l => l.getAttribute('id') === '10188048') || layers[0];
  const q = tr(deepest, 0, 0);
  const solo = mTRS([161.53125, 540, 0], 0, [1, 1]);
  ok(!near(q.m[4], solo[4]) || !near(q.m[0], 1),
     'transform TOTAL != transform sendiri (chain benar-benar mengubah) -> m=[' + q.m.map(num4) + ']');
  ok(Number.isFinite(q.m[0]) && Number.isFinite(q.m[4]), 'matriks finite');
  ok(q.mop > 0 && q.mop <= 1, 'opacity total dalam (0,1] -> ' + num4(q.mop));

  /* rotasi beranimasi di tiap level -> hasil ikut berubah antar waktu */
  const q0 = tr(deepest, 0, 0), qT = tr(deepest, 1, 300);
  ok(!near(q0.m[0], qT.m[0]) || !near(q0.m[4], qT.m[4]),
     'keyframe rotasi induk dievaluasi: m(t=0) != m(t=max) -> ' + q0.m.map(num4) + ' vs ' + qT.m.map(num4));
}

/* =========================================================================
 * [E] preset user — scene1 (nan ko paham db)
 * ======================================================================= */
console.log('\n== [E] preset user scene1: embedScene + gating Group 4 ==');
{
  const U = JSON.parse(fs.readFileSync('/tmp/preset_user.json', 'utf8'));
  const root = parseXML(String(U.scenes[1].text));
  const dur = Number(root.getAttribute('totalTime') || 2000);
  sandbox.scene = sceneOf(root, dur);
  const layers = flatten(root);
  const chained = layers.filter(l => l.__chain && l.__chain.length);
  console.log('  scene1: ' + layers.length + ' layer total, ' + chained.length + ' di dalam rantai');
  ok(layers.length >= 40, 'jumlah layer naik vs flatten lama (39) -> ' + layers.length);
  ok(chained.length > 0, 'ada layer bersarang (' + chained.length + ')');

  const ids = new Set(chained.map(l => {
    const top = l.__chain[0]; return top.getAttribute('id');
  }));
  console.log('  id induk yang muncul di rantai: ' + [...ids].join(', '));
  ok(ids.has('205153674') || ids.has('205153712'),
     'rantai berasal dari <embedScene> preset (Group 2/1/4)');

  /* Group 4 (id 205153674) startTime=1633 -> anaknya harus mati sebelum itu */
  const g4kids = chained.filter(l => l.__chain.some(e => e.getAttribute('id') === '205153674'));
  console.log('  anak Group 4: ' + g4kids.length + ' layer');
  ok(g4kids.length > 0, 'ada anak di dalam Group 4');
  if (g4kids.length) {
    const before = tr(g4kids[0], 0, 1000);
    const after = tr(g4kids[0], 0, 2000);
    ok(before.ok === false, 't=1000ms (< 1633) -> Group 4 anaknya HIDDEN');
    ok(after.ok === true,   't=2000ms (>= 1633) -> Group 4 anaknya VISIBLE');
  }

  /* sim_cc/sim_adjust tetap memakai indeks flatten lama -> pastikan 40 layer scene0 utuh */
  const r0 = parseXML(String(U.scenes[0].text));
  sandbox.scene = sceneOf(r0, Number(r0.getAttribute('totalTime') || 2000));
  const l0 = flatten(r0);
  ok(l0.length === 40, 'scene0 (tanpa embedScene) tetap 40 layer -> ' + l0.length + ' (indeks sim_cc aman)');
}

console.log('\n' + (fail ? 'GAGAL: ' + fail + ' klaim' : 'SEMUA LULUS'));
process.exit(fail ? 1 : 0);
