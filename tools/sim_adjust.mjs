/* Simulasi jalur render BARU untuk layer coloring (ccB0).
 *
 * Pipeline AM buat layer coloring:
 *   1. fill digambar        -> jadi TOPENG ALPHA
 *   2. efek `lift`          -> "Copy Background": isi = comp * alphaLayer
 *                              (di preset ini fill=0.000000 -> murni backdrop)
 *   3. efek berikutnya      -> ngrade backdrop yang ke-cover
 *   4. composite            -> backdrop + grade, pake opacity/blend layer
 *
 * Guard anti-balok di src/glscene.js render():
 *     if (ccNoFill(l) && !usedComp && blendId === 0) continue;
 * artinya: layer coloring yang efeknya TIDAK nyedot comp (lift rusak/absen)
 * DAN blend-nya normal -> fill mentahnya jangan dibuang ke komposit.
 * Blend campur (lighten/screen) tetap jalan karena gak menutup backdrop.
 *
 * Harus dijaga sinkron dengan src/renderer.js (ccReason) dan src/glscene.js. */
import fs from 'node:fs';

const COLOR_FX = /^(lift|satvib|vignette|replacecolor|exposure|gamma|contrast|brightness|saturation|hue|tint|levels|curves|colorbalance|colorize|duotone|sepia|color|lightness|clarity|shadows|highlights|whitetone|temperature|temp|colortune|colorcorrection)$/i;

/* subset dari BLEND[] di src/glscene.js */
const BLEND = {
  '': 0, 'normal': 0, 'src': 0, 'mask-fill': 0,
  'multiply': 1, 'screen': 2,
  'add': 3, 'plus': 3, 'linear-dodge': 3, 'lighter': 3,
  'overlay': 4,
  'darken': 5, 'darker-color': 5,
  'lighten': 6, 'lighter-color': 6,
  'subtract': 7,
  'difference': 8, 'diff': 8,
  'soft-light': 9,
  'hard-light': 10,
  'color-dodge': 11,
  'color-burn': 12,
  'mask': 13,
  'soft-overlay': 14, 'pin-light': 15, 'linear-light': 16, 'vivid-light': 17,
  'divide': 18, 'exclusion': 19,
  'exclude': 20, 'mask-exclude': 20,
  'linear-burn': 21,
  'color': 0, 'saturation': 0, 'hue': 0, 'luminance': 0, 'luminosity': 0
};

const g = (at, n) => { const r = new RegExp(n + '="([^"]*)"').exec(at); return r ? r[1] : ''; };

function analyze(name, xml) {
  const cw = +(/width="(\d+)"/.exec(xml) || [0, 1080])[1];
  const ch = +(/height="(\d+)"/.exec(xml) || [0, 1080])[1];
  const body = xml.replace(/^[\s\S]*?<scene[^>]*>/, '');
  console.log(`\n##### ${name}  canvas ${cw}x${ch}`);
  let i = -1;
  const rows = [];
  for (const k of body.matchAll(/<([a-zA-Z][\w:-]*)\b([^>]*)>([\s\S]*?)<\/\1>|<([a-zA-Z][\w:-]*)\b([^>]*)\/>/g)) {
    const tag = k[1] || k[4], at = k[2] || k[5] || '', inner = k[3] || '';
    if (!/^(shape|media|text|bookmark|audio|group)$/.test(tag)) continue;
    i++;
    const lab = g(at, 'label') || '';
    const prop = n => { const r = new RegExp('<property name="' + n + '"[^>]*value="([^"]*)"').exec(inner); return r ? r[1] : ''; };
    /* info efek/blend dihitung di luar cabang deteksi biar layer yang kena
     * deteksi label (mis. "ini coloring") ikut kecatat juga */
    const fx = [...inner.matchAll(/<effect[^>]*id="([^"]*)"/g)].map(x => x[1]);
    const short = fx.map(x => x.split('.').pop());
    const bl = g(at, 'blending');
    const hasLift = fx.some(x => /\.lift$/.test(x));
    const blendId = BLEND[(bl || '').toLowerCase()] ?? 0;
    let why = '';
    if (/^cc\b/i.test(lab)) why = 'label';
    else if (/colou?r(ing|s)?|warna|grading/i.test(lab)) why = 'label';
    else if (/^(bg|background|latar)\b/i.test(lab)) why = '';
    else if (tag !== 'shape') why = '';
    else if (g(at, 'fillImage') || g(at, 'fillVideo')) why = '';
    else {
      const ft = g(at, 'fillType');
      const hasFill = /<fillColor/.test(inner) || /<gradient/.test(inner);
      if (!hasFill && ft !== 'color' && ft !== 'gradient') why = '';
      else {
        const colorFx = short.some(x => COLOR_FX.test(x));
        const scM = /<scale[^>]*value="([^"]*)"/.exec(inner);
        const s = (scM ? scM[1] : '1,1').split(',').map(Number);
        /* AM: <property name="size"> disimpan satuan PROXY 1/2 -> x2
         * (deobf.js: this.sizeScale = 0x2; ['de'] size.value * sizeScale) */
        const sz = (prop('size') || '100,100').split(',').map(Number).map(v => v * 2);
        const w = Math.abs(sz[0] * (s[0] || 1)), h = Math.abs(sz[1] * (s[1] || 1));
        const covers = w >= cw * .4 && h >= ch * .4;
        const tM = /<transform>([\s\S]*?)<\/transform>/.exec(inner);
        const tr = tM ? tM[1] : '';
        const opM = /<opacity[^>]*value="([^"]*)"/.exec(tr);
        const op = opM ? parseFloat(opM[1]) : 1;
        const opAnim = /<opacity[^>]*>[\s\S]*?<kf/.test(tr);
        if (ft === 'gradient' && !fx.length && !colorFx) why = '';
        else if (covers) why = 'ukuran';
        else if (colorFx) why = 'efek';
        else if (bl && bl !== 'normal') why = 'blend';
        else if (op < 1 || opAnim) why = 'opacity';
      }
    }
    if (why) {
      const guard = !hasLift && blendId === 0;
      let out;
      if (guard) out = 'GUARD->dibuang (aman, gak jadi balok)';
      else if (hasLift) out = 'ADJUSTMENT->efek jalan, fill jadi alpha';
      else out = `fill+blend(${bl || 'normal'})->tetap, blend gak nutup backdrop`;
      rows.push({ i, lab: lab || tag, why, fx: short, hasLift, bl: bl || 'normal', guard, out });
    }
  }
  if (!rows.length) { console.log('  (tidak ada layer coloring)'); return; }
  for (const r of rows) {
    console.log(`   ${String(r.i).padStart(3)} ${r.lab.slice(0, 18).padEnd(19)}` +
      `det[${r.why}] lift=${r.hasLift ? 'Y' : 'N'} blend=${String(r.bl).padEnd(8)} ${r.out}`);
    console.log(`       efek: ${r.fx.join(', ')}`);
  }
  const g1 = rows.filter(r => r.guard).length, a = rows.filter(r => r.hasLift).length;
  console.log(`  >> total ${rows.length}: adjustment ${a}, guard ${g1}, blend-lain ${rows.length - a - g1}`);
}

const U = JSON.parse(fs.readFileSync('/tmp/preset_user.json', 'utf8'));
U.scenes.forEach((s, i) => analyze('PRESET USER scene' + i + ' (' + (U.metadata.projects[i].title) + ')', String(s.text)));
const S = JSON.parse(fs.readFileSync('/tmp/e2e2.json', 'utf8'));
analyze('SAMPLE LAMA', String(S.scenes ? S.scenes[0].text : (S.project || S)));
