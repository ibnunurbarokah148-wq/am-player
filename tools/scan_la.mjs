/* Sebaran locallyApplied di preset user — dasar keputusan adjustment layer. */
import fs from 'node:fs';
const R = JSON.parse(fs.readFileSync('/tmp/preset_user.json', 'utf8'));
const g = (at, n) => { const r = new RegExp(n + '="([^"]*)"').exec(at); return r ? r[1] : ''; };
const KID = /^(shape|media|text|bookmark|audio|group)$/;

[0, 1].forEach(si => {
  const xml = String(R.scenes[si].text);
  const body = xml.replace(/^[\s\S]*?<scene[^>]*>/, '');
  console.log('#### SCENE ' + si + '  (' + R.metadata.projects[si].title + ')');
  let i = -1;
  const rows = [];
  for (const k of body.matchAll(/<([a-zA-Z][\w:-]*)\b([^>]*)>([\s\S]*?)<\/\1>|<([a-zA-Z][\w:-]*)\b([^>]*)\/>/g)) {
    const tag = k[1] || k[4], at = k[2] || k[5] || '', inner = k[3] || '';
    if (!KID.test(tag)) continue;
    i++;
    const fx = [...inner.matchAll(/<effect([^>]*)>/g)].map(x => ({
      id: ((/id="([^"]*)"/.exec(x[1]) || [,''])[1]).split('.').pop(),
      la: (/locallyApplied="([^"]*)"/.exec(x[1]) || [,''])[1]
    }));
    if (!fx.length) continue;
    const nFalse = fx.filter(e => e.la === 'false').length;
    const nTrue = fx.filter(e => e.la === 'true').length;
    rows.push({
      i, lab: g(at, 'label') || tag,
      img: !!(g(at, 'fillImage') || g(at, 'fillVideo')),
      n: fx.length, nFalse, nTrue,
      la: fx.map(e => e.id + ':' + (e.la === '' ? '?' : e.la[0])).join(' ')
    });
  }
  rows.forEach(r => console.log(
    '  ' + String(r.i).padStart(3) + ' ' + (r.lab || '-').slice(0, 18).padEnd(19) +
    'img=' + (r.img ? 'Y' : 'n') + '  fx=' + String(r.n).padStart(2) +
    '  false=' + String(r.nFalse).padStart(2) + '  true=' + String(r.nTrue).padStart(2) +
    '   ' + r.la.slice(0, 72)));
  const adj = rows.filter(r => r.nFalse > 0);
  console.log('  -> layer punya locallyApplied=false : ' + adj.length +
    '  [' + adj.map(r => r.i + ':' + r.lab).join(' | ') + ']');
});
