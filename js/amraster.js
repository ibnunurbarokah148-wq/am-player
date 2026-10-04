/* amraster.js — INTI RENDER mesin motionary, tanpa satu pun elemen UI.
 *
 * Diangkat dari js/app.js (baris 11-1321) lalu dibereskan:
 *   S.active / S.T / S.playing   -> state modul (setProject / setTime / setPlaying)
 *   renderFrame() / renderLayerBar() -> hook onRefresh()
 *   kanvas _rastCv / _drawWork / offLayer / offComp -> dibuat malas supaya modul
 *     ini tetap bisa diimpor proses node (tools/mot_probe.mjs) tanpa document
 *
 * Titik kontak dengan amgl.js:
 *   rasterContent(l,T,tf,metricsOnly)  -> tekstur inputImg + metrik kotak layer
 *   evalFxParam(fx,key,T)              -> nilai param fx terkf
 *   renderAt / renderAtAsync           -> AMGL.renderFrameGL, fallback Canvas2D
 *
 * dipakai oleh src/renderer.js (UI kita) sebagai pengganti glx/glscene.
 */
import { applyFxStack, applyTransformFx, fxDefault } from './fx.js';
import { fontStackFor } from './preset.js';
import { cameraZoomOf } from './export-plan.js';
import { revealAt } from './draw-engine.js';
import * as AMGL from './amgl.js';

let PROJ = null, TIME = 0, PLAYING = false, onRefresh = null;
export function setProject(p){ PROJ = p || null; }
export function getProject(){ return PROJ; }
export function setTime(t){ TIME = t; }
export function setPlaying(b){ PLAYING = !!b; }
export function setRefresh(fn){ onRefresh = fn; }

const _CV = {};
function _cv(name){ return _CV[name] || (_CV[name] = document.createElement('canvas')); }

export const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
export const lerp=(a,b,t)=>a+(b-a)*t;

export function ensureDrawImage(l){
  const d=l.draw; if(!d||!d.refData||l._dimg||l._dloading) return;
  l._dloading=true;
  const img=new Image();
  img.onload=()=>{ l._dimg=img; l._dloading=false; if(PROJ) onRefresh() };
  img.onerror=()=>{ l._dloading=false };
  img.src=d.refData;
}
// unit kotak -> px kerja

export function drawDrawing(c, l, T){
  const d=l.draw; if(!d) return;
  const W2=360, H2=360;
  const u=W2/100; // px kerja per unit kotak
  const key=W2+'x'+H2+':'+(d.rev||0)+':'+(d.mode||'human');
  let cache=l._drawCache;
  if(!cache||cache.key!==key||T<cache.t-0.001||!cache.mask||!cache.sk){
    cache=l._drawCache={ key, t:-1,
      mask:Object.assign(document.createElement('canvas'),{width:W2,height:H2}),
      sk:Object.assign(document.createElement('canvas'),{width:W2,height:H2}),
      man:Object.assign(document.createElement('canvas'),{width:W2,height:H2}),
      ki:-1, si:0, skDone:0 };
  }
  ensureDrawImage(l);
  const mctx=cache.mask.getContext('2d'), sctx=cache.sk.getContext('2d');
  const f=revealAt(T-(l.startMs||0), d.sketchMs||0, d.colorMs||0, d.mode);
  // --- 1. topeng reveal (inkremental bila T maju) ---
  if(d.cover&&d.cover.pts&&l._dimg){
    const target=Math.floor(f.color*(d.cover.pts.length-1));
    mctx.fillStyle='#fff'; mctx.strokeStyle='#fff';
    mctx.lineWidth=Math.max(2,(d.brush||46)*0.62/(Math.abs(l.sx||200)/200)*u);
    mctx.lineCap='round'; mctx.lineJoin='round';
    let k=cache.ki; // indeks terakhir yg sudah digambar
    if(target<k){ mctx.clearRect(0,0,W2,H2); k=-1 }
    if(target>=0){
      mctx.beginPath();
      const s0=Math.max(0,k);
      mctx.moveTo((d.cover.pts[s0][0]+50)*u,(d.cover.pts[s0][1]+50)*u);
      for(let j=s0+1;j<=target;j++) mctx.lineTo((d.cover.pts[j][0]+50)*u,(d.cover.pts[j][1]+50)*u);
      mctx.stroke();
    }
    cache.ki=target;
  }
  // --- 2. sketsa vektor (inkremental) ---
  if(d.strokes&&d.strokes.length){
    const targetLen=f.sketch*(d.sketchLen||0);
    let si=cache.si, acc=cache.skDone;
    if(targetLen<acc-0.001){ sctx.clearRect(0,0,W2,H2); si=0; acc=0 }
    sctx.strokeStyle=d.sketchColor||'#23232b'; sctx.lineCap='round'; sctx.lineJoin='round';
    sctx.lineWidth=Math.max(1,(d.brush||46)*0.16/(Math.abs(l.sx||200)/200)*u);
    for(;si<d.strokes.length;si++){
      const st=d.strokes[si];
      const rest=targetLen-acc;
      if(rest<=0) break;
      const drawLen=Math.min(rest,st.len);
      sctx.beginPath();
      sctx.moveTo((st.pts[0][0]+50)*u,(st.pts[0][1]+50)*u);
      let a2=0, partial=false;
      for(let i=1;i<st.pts.length;i++){
        const segL=Math.hypot(st.pts[i][0]-st.pts[i-1][0],st.pts[i][1]-st.pts[i-1][1]);
        if(a2+segL<=drawLen+1e-6){ sctx.lineTo((st.pts[i][0]+50)*u,(st.pts[i][1]+50)*u); a2+=segL }
        else { const r=(drawLen-a2)/Math.max(1e-6,segL);
          sctx.lineTo((st.pts[i-1][0]+(st.pts[i][0]-st.pts[i-1][0])*r+50)*u,(st.pts[i-1][1]+(st.pts[i][1]-st.pts[i-1][1])*r+50)*u);
          a2=drawLen; partial=true; break }
      }
      sctx.stroke();
      if(partial){ acc+=drawLen; break }
      acc+=st.len;
    }
    cache.si=si; cache.skDone=acc;
  }
  cache.t=T;
  // --- 3. komposit ke kanvas kerja ---
  const work=_dw()._cv, wctx=_dw()._cx;
  if(work.width!==W2||work.height!==H2){ work.width=W2; work.height=H2 }
  wctx.setTransform(1,0,0,1,0,0); wctx.globalAlpha=1; wctx.globalCompositeOperation='source-over';
  wctx.clearRect(0,0,W2,H2);
  if(l._dimg&&d.cover){
    const tmp=_dw()._tmp, tctx=_dw()._tx;
    if(tmp.width!==W2||tmp.height!==H2){ tmp.width=W2; tmp.height=H2 }
    tctx.setTransform(1,0,0,1,0,0); tctx.globalAlpha=1; tctx.globalCompositeOperation='source-over';
    tctx.clearRect(0,0,W2,H2);
    tctx.drawImage(l._dimg,0,0,W2,H2);
    tctx.globalCompositeOperation='destination-in';
    tctx.drawImage(cache.mask,0,0);
    wctx.drawImage(tmp,0,0);
  }
  // sketsa memudar saat warna selesai
  const mctx2=cache.man.getContext('2d');
  mctx2.setTransform(1,0,0,1,0,0); mctx2.clearRect(0,0,W2,H2);
  drawManualInto(mctx2,l,W2);
  wctx.save();
  wctx.globalAlpha=1-0.8*f.color;
  wctx.drawImage(cache.sk,0,0);
  wctx.restore();
  wctx.drawImage(cache.man,0,0);
  // --- 4. pena di kepala gambar ---
  if(d.mode!=='instant'&&(f.sketch<1||f.color<1)&&(f.sketch>0||f.color>0)){
    let hx=null,hy=null;
    if(f.color>0&&d.cover&&d.cover.pts.length){ const k=Math.min(d.cover.pts.length-1,Math.floor(f.color*(d.cover.pts.length-1))); hx=d.cover.pts[k][0]; hy=d.cover.pts[k][1] }
    else if(d.strokes&&d.strokes.length){ const s=d.strokes[Math.min(d.strokes.length-1,Math.floor(f.sketch*d.strokes.length))]; const p=s.pts[s.pts.length-1]; hx=p[0]; hy=p[1] }
    if(hx!==null){
      const br=Math.max(2,(d.brush||46)/2/(Math.abs(l.sx||200)/200)*u);
      const cxp=(hx+50)*u, cyp=(hy+50)*u;
      wctx.save();
      wctx.strokeStyle='#111'; wctx.lineWidth=Math.max(1.5,br*0.16);
      wctx.beginPath(); wctx.arc(cxp,cyp,Math.max(3,br*0.62),0,Math.PI*2); wctx.stroke();
      wctx.fillStyle='#111';
      wctx.beginPath(); wctx.arc(cxp,cyp,Math.max(1.5,br*0.14),0,Math.PI*2); wctx.fill();
      wctx.restore();
    }
  }
  c.save(); c.beginPath(); c.rect(-50,-50,100,100); c.clip();
  c.drawImage(work,-50,-50,100,100);
  c.restore();
}

export let _drawWork=null;
export function _dw(){ return _drawWork||(_drawWork={ _cv:document.createElement('canvas'), _tmp:document.createElement('canvas'),
  get _cx(){ return this._cv.getContext('2d') }, get _tx(){ return this._tmp.getContext('2d') } }) }

export function hydratePresetMedia(proj){
  (proj.layers||[]).forEach(l=>{
    const hasImg=l._img&&typeof l._img.addEventListener==='function';
    const hasVid=l._vid&&typeof l._vid.addEventListener==='function';
    const hasAud=l._aud&&typeof l._aud.play==='function';
    if(l.mediaSrc&&!hasImg&&!hasVid&&!hasAud){
      l._imgErr=false; l._audErr=false;
      const low=(l.mediaSrc||'').toLowerCase();
      const refresh=()=>{ if(PROJ===proj){ onRefresh(); } };
      if(l.mediaKind==='audio'||l.type==='audio'){
        const a=document.createElement('audio');
        a.src=l.mediaSrc; a.preload='auto';
        a.addEventListener('loadedmetadata',refresh);
        a.addEventListener('error',()=>{ l._audErr=true; refresh(); });
        l._aud=a; l.type='audio';
        if(!l.wave) buildWaveform(l);
      } else if(l.mediaKind==='video'||l.type==='video'||low.includes('.mp4')||low.includes('.mov')||low.includes('.webm')){
        const v=document.createElement('video');
        v.src=l.mediaSrc; v.muted=true; v.loop=false; v.preload='auto'; v.playsInline=true;
        v.setAttribute('playsinline','');
        v.addEventListener('loadedmetadata',refresh);
        v.addEventListener('loadeddata',refresh);
        v.addEventListener('canplay',refresh);
        v.addEventListener('seeked',refresh);
        v.addEventListener('timeupdate',refresh);
        v.addEventListener('error',()=>{ l._imgErr=true; refresh(); });
        try{ v.load() }catch{}
        l._vid=v; l.type='video';
      } else {
        const img=new Image();
        img.decoding='async';
        img.onload=()=>{ l._ready=true; l._imgErr=false; refresh(); };
        img.onerror=()=>{ l._imgErr=true; refresh(); };
        img.src=l.mediaSrc;
        l._img=img; if(l.type!=='video') l.type='image';
      }
    } else if(l.type==='audio'&&l.mediaSrc&&!l.wave&&!l._audErr){
      buildWaveform(l);
    }
  });
}
export const _audioCtx={ctx:null};
export async function buildWaveform(l){
  try{
    if(l._waveBusy) return; l._waveBusy=true;
    const r=await fetch(l.mediaSrc);
    if(!r.ok){ l._waveBusy=false; return }
    const buf=await r.arrayBuffer();
    _audioCtx.ctx=_audioCtx.ctx||new (window.AudioContext||window.webkitAudioContext)();
    const ab=await _audioCtx.ctx.decodeAudioData(buf.slice(0));
    const ch=ab.getChannelData(0);
    const N=160, peaks=new Array(N).fill(0);
    const step=Math.max(1,Math.floor(ch.length/N));
    for(let i=0;i<N;i++){
      let m=0;
      for(let j=i*step;j<Math.min(ch.length,(i+1)*step);j+=7){ const v=Math.abs(ch[j]); if(v>m)m=v }
      peaks[i]=m;
    }
    l.wave=peaks; l._waveBusy=false;
  }catch{ l._waveBusy=false; }
}

export function evalProp(layer, key, T){
  const arr=(layer.kf&&layer.kf[key])||[];
  const base=layer[key];
  if(!arr.length) return base;
  const sorted=[...arr].sort((a,b)=>a.t-b.t);
  if(T<=sorted[0].t) return sorted[0].v;
  if(T>=sorted[sorted.length-1].t) return sorted[sorted.length-1].v;
  let i=0; while(i<sorted.length-1 && T>sorted[i+1].t) i++;
  const a=sorted[i], b=sorted[i+1];
  const p=(T-a.t)/Math.max(1,(b.t-a.t));
  // KALIBRASI zervida: ease milik kf KANAN (segmen masuk kf tsb)
  const e=easeOf(b.ease||'linear', p);
  return lerp(a.v,b.v,e);
}
export function easeOf(type, t){
  // cubicBezier AM asli: "cubicbezier x1 y1 x2 y2" (+ prefiks "reverse")
  if(typeof type==='string'){
    // AM "random x1 y1 x2 y2 ..." -> bezier dgn kontrol tsb (chaos diabaikan;
    // terkalibrasi zervida: random 0.5x4 0.0 = LINEAR)
    const rm=type.match(/^(?:reverse )?random (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/);
    if(rm){ return easeOf('cubicbezier '+rm.slice(1).join(' '), t) }
    const m=type.match(/^(reverse )?cubicbezier (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)$/);
    if(m){
      const x1=+m[2],y1=+m[3],x2=+m[4],y2=+m[5];
      // cari s sehingga kurva-x(s) = t (biseksi)
      let lo=0,hi=1,s=t;
      for(let i=0;i<24;i++){
        s=(lo+hi)/2;
        const xs=(3*(1-s)*(1-s)*s*x1)+(3*(1-s)*s*s*x2)+(s*s*s);
        if(xs<t) lo=s; else hi=s;
      }
      let e=(3*(1-s)*(1-s)*s*y1)+(3*(1-s)*s*s*y2)+(s*s*s);
      if(m[1]) e=1-easeOf(type.slice(8), 1-t); // reverse = cermin kurva
      return Math.max(0,Math.min(1,e));
    }
    if(type.startsWith('reverse ')) return 1-easeOf(type.slice(8), 1-t);
  }
  switch(type){
    case 'cubic': return t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
    case 'bounce': { const n=4; return Math.abs(Math.sin(t*Math.PI*n))*(1-t*0.4)+t*0.2 }
    case 'cyclic': return (Math.sin(t*Math.PI*4)+1)/2;
    case 'steps': return Math.floor(t*4)/4;
    case 'elastic': return t===0?0:t===1?1:Math.pow(2,-10*t)*Math.sin((t*10-0.75)*(2*Math.PI/3))+1;
    case 'random': return (Math.sin(t*39.7)*43758.5)%1*0.5+0.5;
    case 'hold': return 0;
    default: return t;
  }
}

export function renderAt(time, targetCanvas){
  // Path utama: engine WebGL shader asli AM (amgl.js).
  // Throttle token: satu render GL berjalan; frame berikutnya masuk
  // antrian (pending) dan dijalankan saat selesai — preview tetap
  // responsif meski frame berat (fallback otomatis ke Canvas2D).
  const P=PROJ;
  if(!P||!targetCanvas) return;
  TIME=time;
  if(!P||!targetCanvas) return;
  if(GL.useGL && !GL.fail){
    if(GL.busy){ GL.pending=[time,targetCanvas]; return }
    GL.busy=true;
    AMGL.renderFrameGL(P, time, rasterContent, evalFxParam).then(cv=>{
      GL.busy=false; GL.done++;
      if(cv){ blitGL(cv, targetCanvas, P, time) }
      else{ GL.fail=true; render2D(time, targetCanvas) }
      flushGLPending();
    }).catch(()=>{ GL.busy=false; GL.fail=true; render2D(time, targetCanvas); flushGLPending() });
    // catat selesai
    return;
  }
  render2D(time, targetCanvas);
}
export const GL={ useGL:true, fail:false, busy:false, pending:null, done:0 };
if(typeof window!=='undefined'){ window.__gl = GL; window.__amgldbg = AMGL.dbg; }
export function flushGLPending(){
  if(GL.pending && !GL.busy){
    const [t,c]=GL.pending; GL.pending=null;
    if(GL.useGL && !GL.fail) renderAt(t,c); else render2D(t,c);
  }
}
export function blitGL(cv, targetCanvas, P, T){
  const ctx=targetCanvas.getContext('2d');
  if(targetCanvas.width!==P.w||targetCanvas.height!==P.h){ targetCanvas.width=P.w; targetCanvas.height=P.h }
  ctx.setTransform(1,0,0,1,0,0); ctx.globalAlpha=1; ctx.globalCompositeOperation='source-over';
  ctx.clearRect(0,0,P.w,P.h);
  ctx.fillStyle=P.bg||'#000'; ctx.fillRect(0,0,P.w,P.h);
  const cam=PROJ?activeCameraAt(T??TIME):null;
  if(cam){
    // koordinat kamera dalam piksel proyek -> skala ke piksel comp
    const sc=P.w/((P.projW||P.w)||1);
    ctx.save(); applyCameraTransform(ctx,P.w,P.h,cam,T??TIME,sc); ctx.drawImage(cv,0,0); ctx.restore();
  } else ctx.drawImage(cv,0,0);
}
export async function renderAtAsync(time, targetCanvas){
  // versi await (PNG export): pastikan frame GL SELESAI sebelum capture
  const P=PROJ;
  if(!P||!targetCanvas) return;
  TIME=time;
  if(!P||!targetCanvas) return;
  if(GL.useGL && !GL.fail){
    try{
      const cv=await AMGL.renderFrameGL(P, time, rasterContent, evalFxParam);
      if(cv){ blitGL(cv, targetCanvas, P, time); return }
      GL.fail=true;
    }catch{ GL.fail=true }
  }
  render2D(time, targetCanvas);
}
export async function warmGL(){
  // preload semua def efek proyek + kompilasi program + render pertama
  if(!PROJ) return;
  try{
    await AMGL.preloadFx(PROJ);
    const cv=await AMGL.renderFrameGL(PROJ, TIME, rasterContent, evalFxParam);
    if(!cv) GL.fail=true;
  }catch(e){ console.warn('[gl] warm:', e.message) }
  onRefresh();
}

/* rasterContent — konten layer pada transform final, canvas comp-size.
   Dipakai amgl.js sebagai tekstur inputImg + sumber metrik kotak layer. */
export let _rastCv=null;
export function rasterContent(l, T, tf, metricsOnly){
  const P=PROJ; if(!P) return null;
  if(T<l.startMs||T>l.endMs) return null;
  const x=evalProp(l,'x',T)+(tf?.dx||0), y=evalProp(l,'y',T)+(tf?.dy||0);
  const sx=evalProp(l,'sx',T), sy=evalProp(l,'sy',T);
  const rot=evalProp(l,'rot',T)+(tf?.drot||0);
  const op=evalProp(l,'opacity',T);
  const skx=evalProp(l,'skewX',T)||0, sky=evalProp(l,'skewY',T)||0;
  // skala comp vs ruang proyek asli (XML scene): render resolusi beda
  // (mis. export 360p) harus identik dgn 1080p yang di-downscale —
  // posisi/ukuran kotak layer ada di pixel proyek, comp bisa lebih kecil.
  const sc=P.w/(P.projW||P.w);
  const fw=sx/2*(tf?.sx??1)*sc, fh=sy/2*(tf?.sy??1)*sc;
  const out={ cv:null, cx:x*sc, cy:y*sc, rot, fw, fh,
    opacity:clamp(op??100,0,100), blend:l.blend||'normal' };
  if(metricsOnly) return out;
  const Wc=P.w, Hc=P.h;
  if(!_rastCv) _rastCv=document.createElement('canvas');
  if(_rastCv.width!==Wc||_rastCv.height!==Hc){ _rastCv.width=Wc; _rastCv.height=Hc }
  const c=_rastCv.getContext('2d');
  c.setTransform(1,0,0,1,0,0); c.clearRect(0,0,Wc,Hc);
  c.save();
  c.translate(x*sc,y*sc);
  c.rotate(rot*Math.PI/180);
  c.transform(1,Math.tan(sky*Math.PI/180),Math.tan(skx*Math.PI/180),1,0,0);
  c.scale(fw/100,fh/100);
  c.globalAlpha=clamp(l.fillAlpha??100,0,100)/100;
  if(l.shadow?.on){ c.shadowColor=l.shadow.color||'#000'; c.shadowBlur=(l.shadow.blur||12)*sc; c.shadowOffsetX=(l.shadow.dx||0)*sc; c.shadowOffsetY=(l.shadow.dy||0)*sc }
  if(l.type==='text'&&l.text){ drawText(c,l,T) }
  else if((l.type==='image'||l.type==='video')&&l.mediaSrc){ drawMedia(c,l,T) }
  else if(l.type==='drawing'&&l.draw){ drawDrawing(c,l,T) }
  else { drawShape(c,l) }
  if(l.border?.on){ c.shadowColor='transparent'; c.shadowBlur=0; c.lineWidth=l.border.width||4; c.strokeStyle=l.border.color||'#fff'; strokeShape(c,l) }
  c.restore();
  out.cv=_rastCv;
  return out;
}

export function activeCameraAt(T){
  const P=PROJ; if(!P) return null;
  for(let i=P.layers.length-1;i>=0;i--){
    const l=P.layers[i];
    if(l.type==='camera'&&l.visible!==false&&T>=l.startMs&&T<=l.endMs) return l;
  }
  return null;
}
export function applyCameraTransform(ctx,w,h,cam,T,spaceScale){
  const cx=evalProp(cam,'x',T)*spaceScale, cy=evalProp(cam,'y',T)*spaceScale;
  const z=cameraZoomOf(evalProp(cam,'sx',T),evalProp(cam,'sy',T));
  const rot=evalProp(cam,'rot',T)||0;
  ctx.translate(w/2,h/2); ctx.scale(z,z); ctx.rotate(-rot*Math.PI/180); ctx.translate(-cx,-cy);
}

export function render2D(time, targetCanvas){
  const P=PROJ;
  if(!P||!targetCanvas) return;
  const ctx=targetCanvas.getContext('2d');
  const w=P.w,h=P.h;
  if(targetCanvas.width!==w||targetCanvas.height!==h){ targetCanvas.width=w; targetCanvas.height=h }
  ctx.setTransform(1,0,0,1,0,0);
  ctx.globalAlpha=1; ctx.globalCompositeOperation='source-over';
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle=P.bg||'#000'; ctx.fillRect(0,0,w,h);
  const cam=activeCameraAt(time);
  if(cam){ ctx.save(); applyCameraTransform(ctx,w,h,cam,time,1); }
  for(let i=0;i<P.layers.length;i++){
    const l=P.layers[i];
    if(!l.visible) continue;
    if(time<l.startMs||time>l.endMs) continue;
    if(l.type==='audio'||l.type==='camera') continue;
    // Layer copy-background (lift fill=0) & adjustment (displacemap3 tanpa map):
    // isi = SALINAN composite di bawah + efek piksel (ground-truth player AM)
    if(l.copyBg||l.adjFx){ drawCompositeFxLayer(ctx,l,time); continue }
    drawLayer(ctx,l,time);
  }
  if(cam) ctx.restore();
}

export function drawCompositeFxLayer(ctx, l, time){
  const w=ctx.canvas.width, h=ctx.canvas.height;
  if(_cv('comp').width!==w||_cv('comp').height!==h){ _cv('comp').width=w; _cv('comp').height=h }
  const oc=_cv('comp').getContext('2d');
  oc.setTransform(1,0,0,1,0,0);
  oc.clearRect(0,0,w,h);
  oc.drawImage(ctx.canvas,0,0);
  let src=_cv('comp');
  try{
    if(l.fx&&l.fx.length) src=applyFxStack(_cv('comp'), l.fx, time, evalFxParam, l);
  }catch{}
  let op=clamp(evalProp(l,'opacity',time),0,100)/100;
  // Kanal alpha efek transform (fade/pulse-opacity) berlaku juga di sini.
  try{ const tr=applyTransformFx(l.fx||[],time,evalFxParam,PROJ.durationMs,l); op*=(tr.alpha==null?1:tr.alpha) }catch{}
  if(op<=0) return;
  ctx.save();
  ctx.globalAlpha=op;
  ctx.globalCompositeOperation=blendMap(l.blend||'normal');
  ctx.drawImage(src,0,0);
  ctx.restore();
}
export function drawLayer(ctx, l, time=TIME){
  const T=time;
  let x=evalProp(l,'x',T), y=evalProp(l,'y',T);
  const sx=evalProp(l,'sx',T), sy=evalProp(l,'sy',T);
  let rot=evalProp(l,'rot',T);
  const op=evalProp(l,'opacity',T);
  const skx=evalProp(l,'skewX',T)||0, sky=evalProp(l,'skewY',T)||0;
  let alpha=clamp(op,0,100)/100 * clamp(l.fillAlpha??100,0,100)/100;
  let dx=0, dy=0, drot=0, tsx=1, tsy=1;
  try{
    if(l.fx&&l.fx.length){
      const tr=applyTransformFx(l.fx,T,evalFxParam,PROJ.durationMs,l);
      dx=tr.dx||0; dy=tr.dy||0; drot=tr.drot||0;
      tsx=tr.sx||1; tsy=tr.sy||1; alpha*= (tr.alpha==null?1:tr.alpha);
    }
  }catch{}
  try{
    if(l.fx) for(const f of l.fx){
      if(f.on!==false&&(f.id==='blink2')){
        // AM: alpha 0 saat fraksi (freq*t) > 0.5 (dulu sin<0, salah fase).
        const fr=evalFxParam(f,'freq',T)??2;
        if(((T/1000*fr)%1+1)%1>0.5) alpha=0;
      }
    }
  }catch{}
  const blend=l.blend||'normal';
  // offscreen 100x100 unit (kode gambar memakai koordinat -50..50)
  const W=_cv('layer');
  if(W.width!==100){ W.width=100; W.height=100 }
  const wctx=W.getContext('2d');
  wctx.setTransform(1,0,0,1,0,0);
  wctx.clearRect(0,0,100,100);
  wctx.save();
  wctx.translate(50,50); // kode gambar (drawShape/drawMedia) memakai koordinat -50..50
  // HANYA alpha fill warna di sini. Opacity layer dipakai saat draw final
  // (fx seperti tile mengisi latar opaque -> alpha 0.6 akan hilang bila di-bake duluan)
  wctx.globalAlpha=clamp(l.fillAlpha??100,0,100)/100;
  if(l.shadow?.on){ wctx.shadowColor=l.shadow.color||'#000'; wctx.shadowBlur=l.shadow.blur||12; wctx.shadowOffsetX=l.shadow.dx||0; wctx.shadowOffsetY=l.shadow.dy||0 }
  if(l.type==='text'&&l.text){ drawText(wctx,l,T) }
  else if((l.type==='image'||l.type==='video')&&l.mediaSrc){ drawMedia(wctx,l,T) }
  else if(l.type==='drawing'&&l.draw){ drawDrawing(wctx,l,T) }
  else { drawShape(wctx,l) }
  if(l.border?.on){ wctx.shadowColor='transparent'; wctx.shadowBlur=0; wctx.lineWidth=l.border.width||4; wctx.strokeStyle=l.border.color||'#fff'; strokeShape(wctx,l) }
  wctx.restore();
  let src=W;
  if(l.fx?.length){
    try{
      for(const f of l.fx){
        if(f.on!==false&&/^motionblur/.test(f.id)) f._vel=layerVel(l,T);
      }
    }catch{}
    src=applyFxStack(W, l.fx, T, evalFxParam, l);
  }
  ctx.save();
  ctx.globalAlpha=alpha; // opacity layer + gerbang blink2
  ctx.globalCompositeOperation=blendMap(blend);
  ctx.translate(x+dx,y+dy);
  ctx.rotate((rot+drot)*Math.PI/180);
  ctx.transform(1,Math.tan(sky*Math.PI/180),Math.tan(skx*Math.PI/180),1,0,0);
  ctx.scale(sx/200*tsx,sy/200*tsy);
  ctx.drawImage(src,-50,-50,100,100);
  ctx.restore();
}
export function blendMap(b){
  return {
    normal:'source-over',
    multiply:'multiply', darken:'darken', 'darker-color':'darken', 'color-burn':'color-burn', 'burn-linear':'color-burn',
    screen:'screen', 'color-dodge':'color-dodge', 'dodge-linear':'lighter', add:'lighter', lighten:'lighten', 'lighter-color':'lighten',
    overlay:'overlay', 'soft-light':'soft-light', 'hard-light':'hard-light', 'vivid-light':'hard-light', 'pin-light':'hard-light',
    difference:'difference', exclusion:'exclusion', subtract:'difference', divide:'difference',
    hue:'hue', saturation:'saturation', color:'color', luminosity:'luminosity'
  }[b]||'source-over'
}

export function layerVel(l,T){
  const h=33, t0=Math.max(0,T-h), t1=T+h, dt=Math.max(1,t1-t0)/1000;
  let x0=evalProp(l,'x',t0), y0=evalProp(l,'y',t0);
  let x1=evalProp(l,'x',t1), y1=evalProp(l,'y',t1);
  try{
    const a=applyTransformFx(l.fx||[],t0,evalFxParam,PROJ.durationMs,l);
    const b=applyTransformFx(l.fx||[],t1,evalFxParam,PROJ.durationMs,l);
    x0+=a.dx||0; y0+=a.dy||0; x1+=b.dx||0; y1+=b.dy||0;
  }catch{}
  return {vx:(x1-x0)/dt, vy:(y1-y0)/dt};
}
export function evalFxParam(fx, key, T){
  const arr=(fx.kf&&fx.kf[key])||[];
  const raw=fx.params[key];
  const base=(raw===undefined||raw===null)?(fxDefault(fx.id,key)??0):raw;
  if(!arr.length) return base;
  const s=[...arr].sort((a,b)=>a.t-b.t);
  if(T<=s[0].t)return s[0].v; if(T>=s[s.length-1].t)return s[s.length-1].v;
  let i=0; while(i<s.length-1&&T>s[i+1].t)i++;
  const a=s[i],b=s[i+1]; const p=(T-a.t)/Math.max(1,b.t-a.t);
  return lerp(a.v,b.v,easeOf(b.ease||'linear',p)); // ease = kf kanan (kalibrasi zervida)
}
export function hexA(hex,pc){
  const a=Math.max(0,Math.min(100,pc??100))/100;
  const h=(hex||'#000').replace('#','');
  const r=parseInt(h.slice(0,2),16),g=parseInt(h.slice(2,4),16),b=parseInt(h.slice(4,6),16);
  return `rgba(${r||0},${g||0},${b||0},${a})`;
}
export function drawShape(c,l){
  if(l.grad){
    // KALIBRASI g540: gradien AM = EUCLIDEAN dlm ruang piksel nominal
    // `size` (bukan per-axis ternormalisasi). Arah di ruang unit +/-50
    // harus dibobot size^2 per komponen; titik awal tetap fraksi kotak.
    const g=l.grad;
    const nw=Math.max(1,Math.abs(l.sizeRaw? l.sizeRaw[0] : 100));
    const nh=Math.max(1,Math.abs(l.sizeRaw? l.sizeRaw[1] : 100));
    const gx=v=>v*100-50, gy=v=>v*100-50;
    // d = vektor gradien dlm piksel nominal; M = peta p->unit (diag(100/size)).
    // Canvas2D: t = dot(u-g1, Dg)/|Dg|^2. Agar = dot(p-p1, d)/|d|^2
    // (Euclidean, kalibrasi g540) -> Dg = k*(M^-1 d), k = |d|^2/|M^-1 d|^2.
    const dpx=[(g.x2-g.x1)*nw, (g.y2-g.y1)*nh];
    const minvd=[dpx[0]*nw/100, dpx[1]*nh/100];
    const kk=(dpx[0]*dpx[0]+dpx[1]*dpx[1])/Math.max(1e-9, minvd[0]*minvd[0]+minvd[1]*minvd[1]);
    const dgx=minvd[0]*kk, dgy=minvd[1]*kk;
    if(g.type==='radial'){
      const r0=0, r1=Math.hypot(dgx,dgy)||70;
      const rg=c.createRadialGradient(gx(g.x1),gy(g.y1),r0,gx(g.x1),gy(g.y1),Math.max(1,r1));
      rg.addColorStop(0,hexA(g.c1,g.a1??100)); rg.addColorStop(1,hexA(g.c2,g.a2??100));
      c.fillStyle=rg;
    } else {
      const lg=c.createLinearGradient(gx(g.x1),gy(g.y1),gx(g.x1)+dgx,gy(g.y1)+dgy);
      lg.addColorStop(0,hexA(g.c1,g.a1??100)); lg.addColorStop(1,hexA(g.c2,g.a2??100));
      c.fillStyle=lg;
    }
  } else c.fillStyle=l.color||'#E14E7A';
  const s=100, r=l.corner??24;
  c.beginPath();
  let fr='nonzero';
  const polyPath=(n,ro,rot0=-Math.PI/2)=>{ for(let i=0;i<n;i++){ const a=rot0+i*Math.PI*2/n, px=Math.cos(a)*ro, py=Math.sin(a)*ro; i?c.lineTo(px,py):c.moveTo(px,py) } c.closePath() };
  switch(l.shapeKind){
    case 'circle': c.arc(0,0,50,0,Math.PI*2); break;
    case 'tri': case 'triangle': c.moveTo(0,-55); c.lineTo(50,40); c.lineTo(-50,40); c.closePath(); break;
    case 'star': starPath(c,0,0,5,50,22); break;
    case 'plus': plusPath(c,50); break;
    case 'donut': c.arc(0,0,50,0,Math.PI*2); c.arc(0,0,28,0,Math.PI*2,true); fr='evenodd'; break;
    case 'moon': c.arc(0,0,50,0,Math.PI*2); c.arc(22,-12,42,0,Math.PI*2,true); fr='evenodd'; break;
    case 'pie': c.moveTo(0,0); c.arc(0,0,50,-Math.PI/2,-Math.PI/2+Math.PI*1.5); c.closePath(); break;
    case 'teardrop': c.moveTo(0,-52); c.bezierCurveTo(34,-10,50,8,50,22); c.arc(0,22,50,0,Math.PI); c.bezierCurveTo(-50,8,-34,-10,0,-52); c.closePath(); break;
    case 'quad': c.moveTo(0,-50); c.lineTo(50,0); c.lineTo(0,50); c.lineTo(-50,0); c.closePath(); break;
    case 'penta': polyPath(5,50); break;
    case 'poly': polyPath(6,50); break;
    case 'multifoil': for(const [px,py] of [[0,-24],[23,8],[-23,8],[0,0]]){ c.moveTo(px+30,py); c.arc(px,py,30,0,Math.PI*2) } break;
    case 'calloutrr': roundRect(c,-50,-42,100,84,18); c.moveTo(-14,42); c.lineTo(-30,58); c.lineTo(6,42); c.closePath(); break;
    case 'stamp': c.arc(0,0,50,0,Math.PI*2); c.arc(0,0,36,0,Math.PI*2,true); fr='evenodd'; break;
    case 'arrow': c.moveTo(-40,-18);c.lineTo(10,-18);c.lineTo(10,-32);c.lineTo(45,0);c.lineTo(10,32);c.lineTo(10,18);c.lineTo(-40,18);c.closePath(); break;
    case 'line': c.rect(-50,-6,100,12); break;
    case 'wideline': c.rect(-50,-15,100,30); break;
    case 'arc': c.lineWidth=20; c.strokeStyle=c.fillStyle; c.beginPath(); c.arc(0,0,38,Math.PI*0.15,Math.PI*1.35); c.stroke(); return;
    default:
      if(l.shapeKind==='rect') c.rect(-50,-50,100,100);
      else roundRect(c,-50,-50,100,100,r);
  }
  c.fill(fr);
}
export function strokeShape(c,l){
  c.beginPath();
  if(l.shapeKind==='circle')c.arc(0,0,50,0,Math.PI*2);
  else if(l.shapeKind==='rect')c.rect(-50,-50,100,100);
  else roundRect(c,-50,-50,100,100,l.corner??24);
  c.stroke();
}
export function roundRect(c,x,y,w,h,r){ c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);c.arcTo(x+w,y+h,x,y+h,r);c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r);c.closePath() }
export function starPath(c,x,y,n,ro,ri){ for(let i=0;i<n*2;i++){const r=i%2?ri:ro;const a=i*Math.PI/n-Math.PI/2;const px=x+Math.cos(a)*r,py=y+Math.sin(a)*r;i?c.lineTo(px,py):c.moveTo(px,py)}c.closePath() }
export function plusPath(c,s){ const t=s*0.32; c.moveTo(-t,-s);c.lineTo(t,-s);c.lineTo(t,-t);c.lineTo(s,-t);c.lineTo(s,t);c.lineTo(t,t);c.lineTo(t,s);c.lineTo(-t,s);c.lineTo(-t,t);c.lineTo(-s,t);c.lineTo(-s,-t);c.lineTo(-t,-t);c.closePath() }
// Evaluasi satu param fx skalar dgn keyframe (mirip evalFxParam, tanpa katalog).
export function fxScalar(f,key,T,def){
  try{
    const kf=(f.kf&&f.kf[key])||[];
    if(kf.length){
      const s=[...kf].sort((a,b)=>a.t-b.t);
      if(T<=s[0].t) return s[0].v;
      if(T>=s[s.length-1].t) return s[s.length-1].v;
      let i=0; while(i<s.length-1&&T>s[i+1].t)i++;
      const a=s[i],b=s[i+1],p=(T-a.t)/Math.max(1,b.t-a.t);
      return lerp(a.v,b.v,easeOf(b.ease||'linear',p));
    }
    if(f.params&&f.params[key]!==undefined&&f.params[key]!==null) return f.params[key];
  }catch{}
  return def;
}
// Muat font Google Fonts sesuai attr AM (best-effort; offline -> fallback).
export const _fontAsked=new Set();
export function ensureWebFont(fontAttr){
  try{
    const key=String(fontAttr||'');
    if(!key||_fontAsked.has(key)||!document.fonts) return;
    _fontAsked.add(key);
    const m=key.match(/name=([^&]+).*?weight=(\d+)/);
    if(!m) return;
    const fam=decodeURIComponent(m[1].replace(/\+/g,' ')), wt=m[2];
    const url='https://fonts.googleapis.com/css2?family='+encodeURIComponent(fam)+':wght@'+wt+'&display=swap';
    const ff=document.createElement('link'); ff.rel='stylesheet'; ff.href=url;
    ff.onload=()=>{ try{ document.fonts.load(wt+' 32px "'+fam+'"').then(()=>{ if(PROJ) onRefresh() }).catch(()=>{}) }catch{} };
    document.head.appendChild(ff);
  }catch{}
}
export function drawText(c,l,T){
  const t=l.text||{};
  ensureWebFont(t.font);
  const fxs=(l.fx||[]).filter(f=>f.on!==false);
  const ff=(id)=>fxs.find(f=>f.id===id);
  let txt=String(t.content??'Teks');
  // --- efek teks behavioral ( spesifikasi script asli AM ) ---
  const tp=ff('textprogress');
  if(tp){
    const st=fxScalar(tp,'start',T,0)??0, en=fxScalar(tp,'end',T,1)??1;
    const cur=fxScalar(tp,'cursor',T,0)??0;
    const cc=['','_','█','▌','▁','▏','▕','▯','▎'][Math.max(0,Math.min(8,Math.round(cur)))]||'';
    let blink='';
    if(fxScalar(tp,'blink',T,0)){
      const dur=Math.max(1,((l.endMs??T+1)-(l.startMs??T)));
      if(((T/1000)*dur*2)%2>1) blink='';
      else blink=cc;
      txt=txt.slice(Math.round(txt.length*st),Math.round(txt.length*en))+blink;
    } else txt=txt.slice(Math.round(txt.length*st),Math.round(txt.length*en))+cc;
  }
  const cnt=ff('counter');
  if(cnt&&/[-+0-9]/.test(txt)){
    const sc=fxScalar(cnt,'scale',T,1)??1, off=fxScalar(cnt,'offset',T,0)??0;
    txt=txt.split(/([-+]?[0-9,]*\.[0-9,]*|[-+]?[0-9,]+)/g).map(seg=>{
      if(!seg||!/^[-+]?[0-9,]*\.?[0-9,]+$/.test(seg)) return seg;
      const hasComma=seg.includes(',');
      const fx=parseFloat(seg.replace(/,/g,''));
      if(!Number.isFinite(fx)) return seg;
      const adj=fx*sc+off;
      const dp=(seg.split('.')[1]||'').replace(/,/g,'').length;
      let out=adj.toFixed(dp);
      if(hasComma) out=out.replace(/\B(?=(\d{3})+(?!\d))/g,',');
      return out;
    }).join('');
  }
  const tr=ff('textrand');
  if(tr){
    const amt=fxScalar(tr,'amount',T,0)??0;
    if(amt>0.001){
      const st=fxScalar(tr,'start',T,0)??0, en=fxScalar(tr,'end',T,1)??1;
      const cs=fxScalar(tr,'charset',T,0)??0, evo=fxScalar(tr,'evo',T,0)??0;
      const seed=fxScalar(tr,'seed',T,0)??0;
      const sets=['ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz',
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz','0123456789'];
      const chars=sets[Math.max(0,Math.min(3,Math.round(cs)))]||sets[0];
      const i0=Math.round(txt.length*st), i1=Math.round(txt.length*en);
      const h=(n)=>{ const x=Math.sin(n*7.3921+seed*13.7+evo*2.9)*43758.5453; return x-Math.floor(x) };
      txt=txt.split('').map((ch,i)=>{
        if(i<i0||i>=i1||ch===' ') return ch;
        return (h(i)+1)/2>=amt?ch:chars[Math.floor(h(i+99)*chars.length)%chars.length];
      }).join('');
    }
  }
  // --- layout: wrap + align + spacing (unit lokal: 1 AM px = 2 unit) ---
  const fam=fontStackFor(t.font||'');
  const fsPx=Math.max(4,(t.size||48)*2);
  const weight=(fam.weight>=600||/bold/i.test(String(t.font||'')))?'700':'400';
  c.fillStyle=t.color||'#fff';
  c.font=weight+' '+fsPx+'px '+fam.stack;
  c.textBaseline='middle';
  const align=String(t.align||'center').toLowerCase();
  c.textAlign=align==='left'?'left':align==='right'?'right':'center';
  const wrapU=Math.max(0,(t.wrapWidth||0)*2);
  const tsp=ff('text-spacing');
  const lsEm=tsp?(fxScalar(tsp,'letterspacing',T,0)??0):0;
  const lhMul=tsp?(fxScalar(tsp,'linespacing',T,1)??1):1;
  // bungkus manual (measureText) agar wrapWidth AM dihormati
  const words=txt.split(/(\s+)/);
  const lines=[]; let cur='';
  const meas=(s)=>{ try{ return c.measureText(s).width }catch{ return s.length*fsPx*0.6 } };
  for(const wd of words){
    const trial=cur+wd;
    if(wrapU>0&&cur&&meas(trial)+(trial.length*lsEm*fsPx)>wrapU&&cur.trim()){
      lines.push(cur); cur=wd.trimStart();
    } else cur=trial;
  }
  if(cur||!lines.length) lines.push(cur);
  const lh=fsPx*Math.max(0.5,lhMul);
  const y0=-((lines.length-1)*lh)/2;
  const drawLine=(line,y)=>{
    if(!(lsEm>0.001)){ c.fillText(line,0,y); return }
    const adv=lsEm*fsPx;
    let total=meas(line)+adv*Math.max(0,line.length-1);
    let x=align==='right'?-total:align==='left'?0:-total/2;
    const prev=c.textAlign; c.textAlign='left';
    for(const ch of line){ c.fillText(ch,x,y); x+=meas(ch)+adv }
    c.textAlign=prev;
  };
  lines.forEach((ln,i)=>drawLine(ln,y0+i*lh));
}
export function drawMedia(c,l,time=TIME){
  const el=l._img||l._vid;
  if(!el||l._imgErr) return;
  try{
    if(l._vid){
      const v=l._vid;
      // waktu sumber = trim inTime + (waktu layer x speed), dibekukan di outTime
      const want=((time-l.startMs)*(l.speed||1)+(l.inMs||0))/1000;
      const maxS=Math.min(Number.isFinite(l.outMs)?l.outMs/1000:Infinity, (v.duration||Infinity))-0.03;
      const target=clamp(want,0,Math.max(0,maxS));
      const tolerance=PLAYING?0.3:0.04;
      if(Number.isFinite(target)&&Math.abs((v.currentTime||0)-target)>tolerance){
        try{ v.currentTime=target }catch{}
      }
      if(v.readyState<2||!v.videoWidth) return;
    } else if(!el.complete||!el.naturalWidth) return;
    c.save(); c.beginPath(); c.rect(-50,-50,100,100); c.clip();
    const iw=el.videoWidth||el.naturalWidth||100, ih=el.videoHeight||el.naturalHeight||100;
    const mode=(l.mediaFillMode||'stretch').toLowerCase();
    // FIX: crop/fit harus mengikuti ASPEK kotak layer (bukan kotak 1:1),
    // kalau tidak foto terpotong/ditarik tidak sesuai box preview
    const la=Math.abs((l.sy||200))/Math.abs((l.sx||200)); // tinggi/lebar layer
    if(mode==='fill'||mode==='crop'){
      const s=Math.max(100/iw,(100*la)/ih), dw=iw*s, dh=ih*s;
      c.drawImage(el,-dw/2,-dh/2,dw,dh);
    } else if(mode==='fit'||mode==='contain'){
      const s=Math.min(100/iw,(100*la)/ih), dw=iw*s, dh=ih*s;
      c.drawImage(el,-dw/2,-dh/2,dw,dh);
    } else {
      c.drawImage(el,-50,-50,100,100);
    }
    c.restore();
  }catch{}
}
