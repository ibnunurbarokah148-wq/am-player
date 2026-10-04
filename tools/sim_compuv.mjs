/* sim_compuv.mjs — uji offline matriks acPassToComp + remap sampling `comp` (ccB6).
 *
 * Kenapa penting: pass efek kita seukuran extent (bbox layer + PAD) tapi texture
 * `comp` selalu kanvas penuh. Salah ruang = backdrop layer coloring (CC) muncul
 * jadi kotak. Matriks harus memetakan uv pass -> uv kanvas dengan ALGEBAR YANG
 * SAMA dengan shader composite() di src/glscene.js — makanya kedua-duanya diekstrak
 * dari kode asli, bukan ditulis ulang di sini.
 *
 *   pakai : node tools/sim_compuv.mjs
 *   keluar: 0 kalau semua klaim lulus
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
let n = 0, fail = 0;
const ok = (c, msg) => { n++; if (!c) { fail++; console.log('  ✗ ' + msg); } else console.log('  ok  ' + msg); };

/* ---------------------------------------------------------------- ekstraksi */
function sliceBetween(src, startMark, endMark) {
  const a = src.indexOf(startMark);
  const b = src.indexOf(endMark, a + 1);
  if (a < 0 || b < 0) throw new Error('marker tak ketemu: ' + startMark);
  return src.slice(a, b);
}
/* ambil `function <nama>` lengkap dgn badannya (pakai penanda berikutnya —
 * jangan brace-matching: body glx.js penuh literal regex dgn kurung kurawal). */
function grabFunction(src, name, endMark) {
  const a = src.indexOf('function ' + name + '(');
  if (a < 0) throw new Error('fungsi tak ketemu: ' + name);
  const b = src.indexOf(endMark, a);
  if (b < 0) throw new Error('penanda akhir tak ketemu: ' + endMark);
  return src.slice(a, b);
}

const glsceneSrc = fs.readFileSync(path.join(ROOT, 'src/glscene.js'), 'utf8');
const glxSrc = fs.readFileSync(path.join(ROOT, 'src/glx.js'), 'utf8');

const ctx = { Float32Array, console: { log() {} } };
vm.createContext(ctx);
vm.runInContext(grabFunction(glsceneSrc, 'pass2comp', '\n  function applyEffect') +
  '\nthis.pass2comp = pass2comp;', ctx);
vm.runInContext(
  sliceBetween(glxSrc, 'var COMP_CALL =', '  /* ------------------------------------------------------------ glsl loading */') +
  '\nthis.remap = remapCompSampling;', ctx);
const pass2comp = ctx.pass2comp;
const remap = ctx.remap;

/* ---------------------------------------------- referensi: algebar composite()
 * src/glscene.js (shader composite):
 *   vec2 sp = vec2(vUv.x, 1.0-vUv.y) * uScene;   // px kanvas, y-down
 *   vec3 L  = uInv * vec3(sp, 1.0);              // -> lokal layer (pusat 0,0)
 *   vec2 hn = L / uHalf;
 *   vec2 suv = vec2(hn.x*0.5+0.5, 0.5 - hn.y*0.5);
 * Kebalikannya (dari uv pass -> px kanvas) yang dipakai pass2comp:
 */
function naiveCompUv(u, v, m, ext, W, H) {
  const Lx = (u - 0.5) * ext.w;
  const Ly = (0.5 - v) * ext.h;
  const [a, b, c, d, e, f] = m;
  const spx = a * Lx + c * Ly + e;
  const spy = b * Lx + d * Ly + f;
  return [spx / W, 1 - spy / H];
}
/* semantik GLSL `vec3 * mat3` dgn upload kolom-major:
 *   (v*M).j = dot(v, kolom j), kolom j = arr[3j], arr[3j+1], arr[3j+2] */
function glslMulMV(v, arr) {
  const out = [0, 0, 0];
  for (let j = 0; j < 3; j++)
    out[j] = v[0] * arr[3 * j] + v[1] * arr[3 * j + 1] + v[2] * arr[3 * j + 2];
  return out;
}
const near = (a, b, eps = 1e-6 /* Float32: presisi ~1e-7 relatif */) => Math.abs(a - b) <= eps;

/* ============================================================ A. kasus identik
 * layer pas-kanvas, tanpa pad -> matriks HARUS identitas. (yang penting di sini:
 * komposisi yg dibaca layer CC == komposisi kanvas, uv 1:1.) */
console.log('\n[A] layer pas-kanvas tanpa pad -> identitas');
{
  const W = 1080, H = 1920;
  const Sx = 200, Sy = 200;                    // ukuran raster (size x AM_SIZE_SCALE)
  const sx = W / Sx, sy = H / Sy;              // scale transform tepat menutup kanvas
  const m = [sx, 0, 0, sy, W / 2, H / 2];
  const ext = { w: Sx, h: Sy };
  const M = pass2comp(m, ext, W, H);
  const want = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  ok(M.every((x, i) => near(x, want[i], 1e-6)),
     'matriks identitas (max dev ' + Math.max(...M.map((x, i) => Math.abs(x - want[i]))).toExponential(2) + ')');
  for (const [u, v] of [[0, 0], [0.5, 0.5], [1, 1], [0.25, 0.75]]) {
    const r = glslMulMV([u, v, 1], M);
    ok(near(r[0], u, 1e-6) && near(r[1], v, 1e-6), `uv (${u},${v}) -> (${r[0].toFixed(6)},${r[1].toFixed(6)})`);
  }
}

/* ================================================== B. kasus nyata preset lo
 * `ini coloring`: size 100x100 x2 = 200, scale 5.4 x 9.6 -> 1080x1920 persis,
 * pusat (540,960); extent kena PAD (pad = max(16, 0.15*100) = 16) -> 232x232.
 * Dulu: comp dibaca pada skala 1080/232 ... eh tidak — dulu uv pass dipakai
 * langsung sbg uv kanvas (0..1 di seluruh extent) -> komposisi susut ke area
 * extent. Sekarang: pusat extent -> pusat kanvas, dan tepi extent -> tepi
 * kanvas yang diperbesar sebesar pad (di luar kanvas, di-clamp sampler). */
console.log('\n[B] layer pas-kanvas + pad (preset: "ini coloring")');
{
  const W = 1080, H = 1920, Sx = 200, Sy = 200;
  const sx = W / Sx, sy = H / Sy;
  const m = [sx, 0, 0, sy, W / 2, H / 2];
  const pad = Math.max(16, 0.15 * 100);         // PAD_MIN/PAD_RATIO utk half=100
  const ext = { w: Sx + 2 * pad, h: Sy + 2 * pad };
  const M = pass2comp(m, ext, W, H);
  const c = glslMulMV([0.5, 0.5, 1], M);
  ok(near(c[0], 0.5, 1e-6) && near(c[1], 0.5, 1e-6),
     `pusat extent -> pusat kanvas (${c[0].toFixed(6)}, ${c[1].toFixed(6)})`);
  /* tepi extent -> di LUAR kanvas. pad (16px) ditambahkan di ruang RASTER,
   * jadi di kanvas kelebihannya = pad * scale transform (16*5.4 = 86.4px),
   * BUKAN pad mentah. */
  const tl = glslMulMV([0, 0, 1], M), br = glslMulMV([1, 1, 1], M);
  const kx = (sx * pad) / W, ky = (sy * pad) / H;
  ok(near(tl[0], -kx, 1e-6) && near(tl[1], -ky, 1e-6),
     `sudut kiri-atas -> (${tl[0].toFixed(6)}, ${tl[1].toFixed(6)}) expect (-${kx.toFixed(6)}, -${ky.toFixed(6)})`);
  ok(near(br[0], 1 + kx, 1e-6) && near(br[1], 1 + ky, 1e-6),
     `sudut kanan-bawah -> (${br[0].toFixed(6)}, ${br[1].toFixed(6)}) expect (1+${kx.toFixed(6)}, 1+${ky.toFixed(6)})`);
  /* lapisan dlm (uv .25..75) harus jatuh DI dalam kanvas */
  const inside = [[0.25, 0.25], [0.75, 0.75], [0.5, 0.25], [0.25, 0.5]];
  ok(inside.every(([u, v]) => {
    const r = glslMulMV([u, v, 1], M);
    return r[0] > 0 && r[0] < 1 && r[1] > 0 && r[1] < 1;
  }), 'area dalam extent tetap jatuh di dalam kanvas');
}

/* ======================================================= C. kasus asimetris
 * rotasi + skala tak-sama-sama + translasi — INI yang nangkep salah susun
 * kolom/baris (kasus diagonal di [A] tidak). dibandingkan dgn algebar
 * composite() di atas, bukan dgn salinan matriksnya sendiri. */
console.log('\n[C] rotasi 30° + skala tak-rata + translasi vs algebar composite()');
{
  const W = 1920, H = 1080;
  const th = 30 * Math.PI / 180, kx = 2.5, ky = 1.75, tx = 700, ty = 300;
  const a = kx * Math.cos(th), c = -ky * Math.sin(th);
  const b = kx * Math.sin(th), d = ky * Math.cos(th);
  const m = [a, b, c, d, tx, ty];               // gaya canvas: x'=a x + c y + e
  const ext = { w: 613, h: 487 };               // extent ganjil, biar ketahuan
  const M = pass2comp(m, ext, W, H);
  let worst = 0;
  for (const u of [0, 0.13, 0.5, 0.77, 1])
    for (const v of [0, 0.31, 0.5, 0.62, 1]) {
      const r = glslMulMV([u, v, 1], M);
      const g = naiveCompUv(u, v, m, ext, W, H);
      worst = Math.max(worst, Math.abs(r[0] - g[0]), Math.abs(r[1] - g[1]));
    }
  ok(worst < 1e-6, '25 titik uv cocok dgn algebar composite() (max dev ' + worst.toExponential(2) + ')');
  const ctr = glslMulMV([0.5, 0.5, 1], M);
  ok(near(ctr[0], tx / W, 1e-6) && near(ctr[1], 1 - ty / H, 1e-6),
     `pusat extent -> pusat layer di kanvas (${ctr[0].toFixed(6)}, ${ctr[1].toFixed(6)})`);
  /* afinitas: (u+v,1) == (u,1)+(v,1)-(1,1) */
  const p = glslMulMV([0.3, 0.7, 1], M), q1 = glslMulMV([0.3, 0, 1], M),
        q2 = glslMulMV([0, 0.7, 1], M), q3 = glslMulMV([0, 0, 1], M);
  ok(near(p[0], q1[0] + q2[0] - q3[0], 1e-6) && near(p[1], q1[1] + q2[1] - q3[1], 1e-6),
     'matriks afine (superposisi translasi cocok)');
}

/* ============================================= D. kasus premis lama = salah
 * dokumentasikan kenapa patch ini ada: uv pass dipakai langsung sbg uv kanvas. */
console.log('\n[D] premis lama (tanpa remap) — untuk kuantifikasi');
{
  const W = 1080, H = 1920;
  const cases = [
    ['makasih',        54953, 63272],
    ['ya ngentot',      1920,  1920],
    ['ini coloring',     1080,  1920],
  ];
  for (const [lbl, fw, fh] of cases) {
    const pad = Math.max(16, 0.15 * Math.max(fw, fh) / 2);
    const ew = Math.min(4096, Math.ceil(fw / 2 + pad) * 2);
    const eh = Math.min(4096, Math.ceil(fh / 2 + pad) * 2);
    const skalaLama = Math.min(1, W / ew) * Math.min(1, H / eh);
    console.log(`     ${lbl.padEnd(14)} extent=${ew}x${eh}  komposisi lama ≈ ${(skalaLama * 100).toFixed(1)}%`);
  }
}

/* ================================================ E. remap sampling `comp` */
console.log('\n[E] remapCompSampling terhadap seluruh webfx/glsl');
{
  const dir = path.join(ROOT, 'webfx/glsl');
  const files = fs.readdirSync(dir).filter(f => /\.(fragment|vert)$/.test(f));
  let site = 0, patched = 0, decl = 0, inputTouched = 0, unparsed = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const rawSite = (src.match(/texture2D(?:Cv)?\s*\(\s*comp\s*,/g) || []).length;
    const out = remap(src, f);
    if (out === src) {
      if (rawSite) unparsed++;
      continue;
    }
    site += rawSite;
    patched++;
    if (/uniform mat3 acPassToComp;/.test(out)) decl++;
    if (/texture2DCv\(\s*inputImg\s*,\s*acCompUv/.test(out)) inputTouched++;
    const left = (out.match(/texture2D(?:Cv)?\s*\(\s*comp\s*,(?!acCompUv)/g) || []).length;
    if (left) { fail++; n++; console.log(`  ✗ ${f}: ${left} site comp belum dibungkus`); }
    if (!/acCompUv\(/.test(out)) { fail++; n++; console.log(`  ✗ ${f}: tak ada acCompUv`); }
    /* hitung pemanggilan saja — deklarasi `vec2 acCompUv(` ikut terhitung */
    const calls = (out.match(/acCompUv\(/g) || []).length - (decl ? 1 : 0);
    if (calls !== rawSite) {
      fail++; n++; console.log(`  ✗ ${f}: jumlah acCompUv=${calls} tak sama dgn site (${rawSite})`);
    }
  }
  ok(site === 75, `site \`comp\` terdeteksi = ${site} (harus 75)`);
  ok(patched === 43, `file ke-patch = ${patched} (harus 43)`);
  ok(decl === 43, `deklarasi acPassToComp disisipkan di ${decl} file`);
  ok(unparsed === 0, `tak ada file gagal diparse (${unparsed})`);
  ok(inputTouched === 0, 'inputImg TIDAK ikut dibungkus (ruangnya ruang pass)');
  /* volumetric-clouds punya fungsi lokal bernama `comp()` — tak boleh tersentuh */
  const vc = fs.readFileSync(path.join(dir, 'volumetric-clouds.0.fragment'), 'utf8');
  ok(remap(vc, 'volumetric-clouds') === vc, 'volumetric-clouds (ada fn lokal comp()) tak disentuh');
}

console.log(`\n======== ${n - fail}/${n} lulus ========`);
process.exit(fail ? 1 : 0);
