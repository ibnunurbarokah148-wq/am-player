/* player.js — PEMUTAR PRESET Alight Motion (tanpa editor, tanpa login).
 *
 * Peran: buka preset -> parse -> set proyek di inti render -> putar.
 *   import js/preset.js      parseAMXML  (baca <scene>, deteksi CC)
 *   import js/amraster.js    inti render (rasterContent/evalFxParam/renderAt/GL)
 *
 * Sengaja TIDAK memakai js/app.js (itu editor lengkap: timeline layer, panel
 * efek, ekspor, gambar). Di sini cuma ada kanvas + transport + pemuat file,
 * supaya jalurnya pendek dan error-nya gampang dilacak.
 *
 * Sumber preset:
 *   .xml/.txt      -> langsung parse
 *   .zip/.amproj   -> JSZip, cari berkas ber-root <scene>, media ikut dibungkus
 *                     (amproj:<nama> -> blob: lokal) jadi offline pun utuh
 *   .json          -> hasil /api/share (scenes + media map)
 *   link share     -> GET /api/share?url=... (server yang tarik paketnya)
 *
 * Semua error runtime ditangkap ke #errbox biar kelihatan di layar, bukan
 * cuma di console.
 */
import { parseAMXML } from './preset.js';
import * as AMR from './amraster.js';

/* preset bawaan tombol "Contoh" (sudah pernah ditarik server, biasanya instan) */
const SAMPLE = 'https://alightcreative.com/am/share/u/8ns27gduKRabkaP6uyFz4RWsv8k2/p/1S1Llf9tfe-ddbecbc4a5000313';

const el = {};
const st = { P: null, T: 0, playing: false, rate: 1, last: 0, dirty: true };

/* ------------------------------------------------------------------ util */

/** Ganti referensi `amproj:<nama>` di teks scene jadi URL yang benar-benar
 *  bisa diambil. map = { 'foto.jpg': '/api/share/pkg/<token>/foto.jpg' }.
 *  Ekspos supaya bisa diuji proses node tanpa DOM. */
export function remapMedia(text, map) {
  if (!text || !map) return text;
  return String(text)
    /* beratribut: boleh ada spasi di nama berkas -> henti tanda kutip */
    .replace(/(["'])amproj:([^"']+)(["'])/g, (m, q1, n, q2) =>
      (map[n] != null && q1 === q2) ? q1 + map[n] + q1 : m)
    /* sisa yang tak beratribut: berhenti di spasi/kutip */
    .replace(/amproj:([^\s"'<>]+)/g, (m, n) => (map[n] != null ? map[n] : m));
}

/** Cari berkas .xml paling menjanjikan dari daftar nama di zip. */
export function pickXmlName(names) {
  const xml = names.filter(n => /\.xml$/i.test(n));
  const score = n => {
    const s = n.toLowerCase();
    if (/project|scene|main|content/.test(s)) return 0;
    if (/preset|effect/.test(s)) return 2;
    return 1;
  };
  return xml.sort((a, b) => score(a) - score(b))[0] || null;
}

const fmtMs = ms => {
  ms = Math.max(0, Math.round(ms));
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), r = ms % 1000;
  const p = (v, n = 2) => String(v).padStart(n, '0');
  return `${p(m)}:${p(s % 60)}.${p(r, 3)}`;
};

function note(msg, isErr) {
  if (!el.note) return;
  el.note.innerHTML = msg;
  el.note.classList.toggle('err', !!isErr);
}

function stat(text, on) {
  if (!el.stat) return;
  el.stat.textContent = text;
  el.stat.classList.toggle('on', !!on);
}

function pushErr(line) {
  if (!el.errbox || !el.errList) return;
  const stamp = new Date().toTimeString().slice(0, 8);
  const row = document.createElement('div');
  row.textContent = `[${stamp}] ${line}`;
  el.errList.appendChild(row);
  while (el.errList.children.length > 60) el.errList.removeChild(el.errList.firstChild);
  el.errbox.classList.add('show');
  if (el.btnErr) el.btnErr.textContent = 'log error ●';
}

/* ------------------------------------------------------------- proyek/fr */

function fit() {
  const P = st.P;
  if (!P || !el.cv) return;
  if (el.cv.width !== P.w || el.cv.height !== P.h) { el.cv.width = P.w; el.cv.height = P.h; }
  el.cv.style.aspectRatio = `${P.w} / ${P.h}`;
}

function paint() {
  const P = st.P;
  if (!P) return;
  el.scrub.max = String(Math.max(0, Math.round(P.durationMs)));
  el.scrub.value = String(Math.round(st.T));
  el.tc.textContent = fmtMs(st.T) + ' / ' + fmtMs(P.durationMs);
}

function setPlaying(b) {
  st.playing = !!b;
  st.dirty = true;
  if (el.btnPlay) { el.btnPlay.textContent = st.playing ? '❚❚' : '▶'; }
  AMR.setPlaying(st.playing);
}

function seek(t) {
  const P = st.P; if (!P) return;
  st.T = Math.max(0, Math.min(P.durationMs, t));
  st.last = 0;
  st.dirty = true;
  paint();
}

function loop(ts) {
  const P = st.P;
  if (P) {
    if (st.playing) {
      const dt = st.last ? Math.min(200, ts - st.last) : 0;
      st.last = ts;
      st.T += dt * st.rate;
      if (st.T >= P.durationMs) { st.T = P.durationMs; setPlaying(false); }
      st.dirty = true;
    }
    if (st.dirty) {
      st.dirty = false;
      AMR.renderAt(st.T, el.cv);      // internal: antrian GL + fallback Canvas2D
      paint();
    }
  }
  requestAnimationFrame(loop);
}

async function openProject(p) {
  if (!p || !p.layers || !p.layers.length) throw new Error('preset kosong / gagal dibaca');
  st.P = p; st.T = 0; st.dirty = true;
  AMR.setProject(p);
  fit(); paint();
  el.title.textContent = p.name || 'Preset';
  if (el.ghost) el.ghost.hidden = true;
  AMR.hydratePresetMedia(p);          // bikin _img/_vid/_aud dari mediaSrc
  const fxCount = p.layers.reduce((a, l) => a + (l.fx ? l.fx.length : 0), 0);
  const ccCount = p.layers.filter(l => l.copyBg || l.adjFx).length;
  stat(`${p.layers.length} layer · ${fxCount} fx`, true);
  note(`<b>${p.name || 'preset'}</b> · ${p.w}×${p.h} · ${p.fps}fps · ` +
       `${fmtMs(p.durationMs)} · ${p.layers.length} layer · ${fxCount} instance efek · ` +
       `${ccCount} layer CC (copyBg/adjFx)`);
  try { await AMR.warmGL(); } catch (e) { pushErr('warmGL: ' + (e.message || e)); }
  glBadge();
  setPlaying(true);                    // pemutar: langsung jalan
}

function glBadge() {
  if (!el.glBadge) return;
  const g = AMR.GL;
  el.glBadge.textContent = g.fail ? 'engine: canvas2d (GL gagal)' : `engine: webgl · ${g.done} frame`;
  el.glBadge.classList.toggle('on', !g.fail);
}

export async function openXmlText(text, name) {
  const p = parseAMXML(text, name || 'Preset');
  await openProject(p);
}

/** JSON hasil /api/share (dan file simpanan kita): {scenes, media, metadata} */
export async function openJson(obj) {
  const scenes = obj && obj.scenes;
  if (!Array.isArray(scenes) || !scenes.length) throw new Error('json tanpa scenes');
  const title = (obj.metadata && obj.metadata.title) || scenes[0].name || 'Preset';
  const shareUrl = obj.metadata && obj.metadata.url;
  if (shareUrl) {
    note('tarik paket dari link share… (pertama kali bisa ±30 dtk, sesudahnya cache)');
    try {
      const j = await openShare(shareUrl);
      if (j) return;
    } catch (e) { pushErr('tarik share: ' + (e.message || e)); note('tarik share gagal — pakai isi file', true); }
  }
  const text = remapMedia(scenes[0].text, obj.media);
  await openXmlText(text, title);
}

/** GET /api/share?url=... -> {ok, metadata, scenes, media} */
export async function openShare(url) {
  const r = await fetch('/api/share?url=' + encodeURIComponent(url));
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false || !j.scenes) throw new Error(j.error || `HTTP ${r.status}`);
  const scenes = j.scenes;
  if (!scenes.length) throw new Error('link tidak punya scene');
  const text = remapMedia(scenes[0].text, j.media);
  await openXmlText(text, (j.metadata && j.metadata.title) || scenes[0].name || 'Share');
  return j;
}

async function loadJSZip() {
  if (window.JSZip) return window.JSZip;
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = '/vendor/jszip.min.js'; s.onload = res;
    s.onerror = () => rej(new Error('JSZip gagal dimuat'));
    document.head.appendChild(s);
  });
  if (!window.JSZip) throw new Error('JSZip tidak tersedia');
  return window.JSZip;
}

async function openZip(file) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const names = Object.keys(zip.files).filter(n => !zip.files[n].dir);
  /* media yang ikut terbungkus -> blob lokal, jadi preset zip jalan offline */
  const map = {};
  for (const n of names) {
    if (/\.(jpe?g|png|webp|gif|bmp|mp4|mov|webm|m4a|mp3|wav)$/i.test(n)) {
      const base = n.split('/').pop();
      const url = URL.createObjectURL(await zip.files[n].async('blob'));
      map[base] = url; map[n] = url;
    }
  }
  const xmls = names.filter(n => /\.xml$/i.test(n)).sort();
  for (const n of xmls) {                 // cari yang benar-benar ber-<scene>
    const t = await zip.files[n].async('string');
    if (/<scene[\s>]/i.test(t)) return openXmlText(remapMedia(t, map), n);
  }
  if (xmls.length) {
    const t = await zip.files[xmls[0]].async('string');
    return openXmlText(remapMedia(t, map), xmls[0]);
  }
  /* ada json bundle? */
  const jn = names.find(n => /\.json$/i.test(n) && !/index\.json/i.test(n));
  if (jn) return openJson(JSON.parse(await zip.files[jn].async('string')));
  throw new Error('zip tidak memuat berkas <scene>');
}

async function openFile(file) {
  if (!file) return;
  note(`membuka ${file.name} (${Math.round(file.size / 1024)} KB)…`);
  const n = (file.name || '').toLowerCase();
  if (n.endsWith('.json')) return openJson(JSON.parse(await file.text()));
  if (/\.(zip|amproj|alight)$/.test(n)) return openZip(file);
  return openXmlText(await file.text(), file.name);
}

/* ------------------------------------------------------------------- init */

function init() {
  ['title', 'glBadge', 'stat', 'stage', 'cv', 'ghost', 'drop', 'scrub', 'tc', 'spd',
   'note', 'file', 'lnk', 'errbox', 'errList', 'btnErr', 'btnPlay', 'btnStart',
   'btnFull', 'btnFile', 'btnEx', 'btnLoad'].forEach(id => { el[id] = document.getElementById(id); });
  el.cv = document.getElementById('preview');

  AMR.setRefresh(() => { st.dirty = true; });
  glBadge();

  window.addEventListener('error', e => pushErr(`error: ${e.message || e.type}  ${(e.filename || '').split('/').pop()}:${e.lineno || 0}`));
  window.addEventListener('unhandledrejection', e => {
    const r = e.reason;
    pushErr('promise: ' + ((r && (r.stack || r.message)) || String(r)));
  });

  const guard = fn => async (...a) => { try { return await fn(...a); } catch (e) { pushErr((e && e.message) || String(e)); note(`gagal: ${(e && e.message) || e}`, true); } };

  el.btnPlay.onclick = () => { if (!st.P) { el.file.click(); return; } setPlaying(!st.playing); };
  el.btnStart.onclick = () => seek(0);
  el.spd.onchange = () => { st.rate = parseFloat(el.spd.value) || 1; };
  el.scrub.addEventListener('input', () => seek(+el.scrub.value));
  el.btnFull.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else (el.stage.requestFullscreen?.() || Promise.resolve()).catch?.(() => {});
  };

  el.btnFile.onclick = () => el.file.click();
  el.file.onchange = guard(() => openFile(el.file.files[0]));
  el.btnEx.onclick = guard(() => { el.lnk.value = SAMPLE; return openShare(SAMPLE); });
  el.btnLoad.onclick = guard(() => {
    const u = (el.lnk.value || '').trim();
    if (!/^https?:\/\//i.test(u)) throw new Error('link belum valid (harus http/https)');
    return openShare(u);
  });
  el.btnErr.onclick = () => {
    const on = el.errbox.classList.toggle('show');
    if (!on) { el.btnErr.textContent = 'log error'; el.errList.innerHTML = ''; }
  };
  document.getElementById('errClose').onclick = () => el.btnErr.onclick();

  /* jatuhkan file ke mana pun di layar */
  ['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, e => {
    e.preventDefault(); document.body.classList.add('dragging');
  }));
  ['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => {
    e.preventDefault(); if (ev === 'dragleave' && e.relatedTarget) return;
    document.body.classList.remove('dragging');
  }));
  document.addEventListener('drop', e => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) guard(() => openFile(f))();
  });

  /* spasi = putar/jeda · ←/→ = geser 1 frame · f = layar penuh */
  document.addEventListener('keydown', e => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); if (st.P) setPlaying(!st.playing); }
    else if (e.code === 'ArrowLeft') seek(st.T - 1000 / ((st.P && st.P.fps) || 30));
    else if (e.code === 'ArrowRight') seek(st.T + 1000 / ((st.P && st.P.fps) || 30));
    else if (e.key === 'f') el.btnFull.onclick();
  });

  window.addEventListener('resize', () => { fit(); st.dirty = true; });
  requestAnimationFrame(loop);

  /* #<url> langsung buka; kalau tidak ada, biarkan kosong */
  const h = decodeURIComponent((location.hash || '').replace(/^#/, ''));
  if (/^https?:\/\//i.test(h)) { el.lnk.value = h; guard(() => openShare(h))(); }
}

if (typeof document !== 'undefined') init();
