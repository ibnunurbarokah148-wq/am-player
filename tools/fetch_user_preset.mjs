process.env.AM_NO_LISTEN = '1';   // jangan nge-listen port — kita cuma mau resolveShare()
const fs = await import('node:fs');
const { resolveShare } = await import('../index.js');

const url = 'https://alightcreative.com/am/share/u/8ns27gduKRabkaP6uyFz4RWsv8k2/p/1S1Llf9tfe-ddbecbc4a5000313';
console.log('resolve:', url);
const t0 = Date.now();
const r = await resolveShare(url);
console.log('selesai dalam', ((Date.now() - t0) / 1000).toFixed(1) + 's');
console.log('keys:', Object.keys(r).join(','));
console.log('metadata:', JSON.stringify(r.metadata).slice(0, 900));
console.log('scenes:', r.scenes ? r.scenes.length : 0, '| media:', r.media ? r.media.length : 0);
if (r.scenes) r.scenes.forEach((s, i) => console.log(`  scene[${i}] len=${(s.text || '').length}`));
fs.writeFileSync('/tmp/preset_user.json', JSON.stringify(r));
console.log('disimpan -> /tmp/preset_user.json');
