/* Simulasi ccReason() di dua project: preset user + sample lama.
 * Sama persis dengan logika di src/renderer.js (harus dijaga sinkron). */
import fs from 'node:fs';

const COLOR_FX = /^(lift|satvib|vignette|replacecolor|exposure|gamma|contrast|brightness|saturation|hue|tint|levels|curves|colorbalance|colorize|duotone|sepia|color|lightness|clarity|shadows|highlights|whitetone|temperature|temp|colortune|colorcorrection)$/i;

const g = (at, n) => { const r = new RegExp(n + '="([^"]*)"').exec(at); return r ? r[1] : ''; };

function analyze(name, xml) {
  const cw = +(/width="(\d+)"/.exec(xml) || [0, 1080])[1];
  const ch = +(/height="(\d+)"/.exec(xml) || [0, 1080])[1];
  const body = xml.replace(/^[\s\S]*?<scene[^>]*>/, '');
  console.log(`\n##### ${name}  canvas ${cw}x${ch}`);
  let i = -1;
  const sup = [], keep = [];
  for (const k of body.matchAll(/<([a-zA-Z][\w:-]*)\b([^>]*)>([\s\S]*?)<\/\1>|<([a-zA-Z][\w:-]*)\b([^>]*)\/>/g)) {
    const tag = k[1] || k[4], at = k[2] || k[5] || '', inner = k[3] || '';
    if (!/^(shape|media|text|bookmark|audio|group)$/.test(tag)) continue;
    i++;
    const lab = g(at, 'label') || '';
    const prop = n => { const r = new RegExp('<property name="' + n + '"[^>]*value="([^"]*)"').exec(inner); return r ? r[1] : ''; };
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
        const fx = [...inner.matchAll(/<effect[^>]*id="([^"]*)"/g)].map(x => x[1].split('.').pop());
        const colorFx = fx.some(x => COLOR_FX.test(x));
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
        const bl = g(at, 'blending');
        if (ft === 'gradient' && !fx.length && !colorFx) why = '';
        else if (covers) why = 'ukuran';
        else if (colorFx) why = 'efek';
        else if (bl && bl !== 'normal') why = 'blend';
        else if (op < 1 || opAnim) why = 'opacity';
      }
    }
    const row = `${String(i).padStart(3)} ${(lab || tag).slice(0, 20).padEnd(21)}${why ? 'SUPPRESS[' + why + ']' : 'gambar'}`;
    (why ? sup : keep).push(row);
  }
  console.log('  == SUPPRESS (' + sup.length + ') ==');
  sup.forEach(r => console.log('   ', r));
  const risky = keep.filter(r => /shape/.test(r) && !/media/.test(r) && !/img/.test(r));
  console.log('  == TETAP DIGAMBAR (' + keep.length + ') ; shape non-media yang masih lolos: ' + risky.length + ' ==');
  risky.slice(0, 12).forEach(r => console.log('   ', r));
}

const U = JSON.parse(fs.readFileSync('/tmp/preset_user.json', 'utf8'));
U.scenes.forEach((s, i) => analyze('PRESET USER scene' + i + ' (' + (U.metadata.projects[i].title) + ')', String(s.text)));
const S = JSON.parse(fs.readFileSync('/tmp/e2e2.json', 'utf8'));
analyze('SAMPLE LAMA', String(S.scenes ? S.scenes[0].text : (S.project || S)));
