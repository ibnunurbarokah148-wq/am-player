const $=id=>document.getElementById(id);const canvas=$('canvas'),ctx=canvas.getContext('2d');let scene=null,mediaSlots=[],audioTracks=[],mediaMap=new Map(),playing=false,offset=0,started=0,raf=0,loop=true;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));const num=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;const attr=(e,n,d='')=>e?.getAttribute(n)??d;const vec=v=>String(v||'').split(',').map(Number);const fmt=ms=>{const s=Math.max(0,ms)/1000;return`${String(Math.floor(s/60)).padStart(2,'0')}:${(s%60).toFixed(2).padStart(5,'0')}`};
function toast(t){const e=$('toast');e.textContent=t;e.classList.add('show');setTimeout(()=>e.classList.remove('show'),2600)}function status(t){const s=$('projectState');if(s)s.textContent=t;const sub=$('subtitle');if(sub)sub.textContent=t}
function color(v){v=String(v||'#ff000000');if(/^#[0-9a-f]{8}$/i.test(v))return`rgba(${parseInt(v.slice(3,5),16)},${parseInt(v.slice(5,7),16)},${parseInt(v.slice(7,9),16)},${parseInt(v.slice(1,3),16)/255})`;return v}
/* flatten(root) -> daftar layer GEOMETRIS yang digambar, urutan AMC/over-under.
 *
 * Dua lubang lama, keduanya ditemukan tools/audit_amproj.mjs:
 *   1. tag `embedScene` (precomp AM / "Group") TIDAK ada di whitelist dan tidak
 *      pernah direkursi -> SELURUH subtree-nya hilang dari preview.
 *      Preset "nan ko paham db" punya 3 group; 2 di antaranya nyangkut di sini.
 *   2. <transform> milik <group>/<embedScene> sendiri harus diwariskan ke anak.
 *      Kita TIDAK bakar (bake) ke anak — keyframe-nya animasi, harus dievaluasi
 *      tiap frame. Simpan saja rantainya di `layer.__chain` (luar -> dalam) dan
 *      kumpulkan matriksnya di tr() (renderer.js) saat render.
 *
 * Urutan rantai: M_total = M_luar * ... * M_dalam * M_layer  (kiri * kanan,
 * sama kayak urutan ctx.translate/rotate/scale).
 * Pivot ikut DIABAIKAN — sama persis dengan `xe()` di deobf.js
 * (translate -> rotate -> scale, konten dipusatkan di 0,0) yang juga tak baca pivot.
 */
function flatten(root,out=[],chain){
  chain=chain||[];
  for(const e of root.children){
    if(e.tagName==='group'||e.tagName==='embedScene'){flatten(e,out,chain.concat(e));continue}
    if(e.tagName==='scene'){flatten(e,out,chain);continue}   /* <scene> di dalam embedScene */
    const decl=e.tagName==='media'&&e.hasAttribute('uri')&&!e.hasAttribute('startTime');
    if(!decl&&['shape','text','media','color','drawing'].includes(e.tagName)){
      if(chain.length)e.__chain=chain;   /* XML element boleh dikasih properti */
      out.push(e)
    }
  }
  return out}
function bezier(x1,y1,x2,y2,t){let lo=0,hi=1,u=t;for(let i=0;i<14;i++){u=(lo+hi)/2;const x=3*(1-u)**2*u*x1+3*(1-u)*u**2*x2+u**3;if(x<t)lo=u;else hi=u}return 3*(1-u)**2*u*y1+3*(1-u)*u**2*y2+u**3}
/* == easing: port VERBATIM dari runtime/preset.html (preset-ZQDZXE2A.js) ==
 * Di sana ada parser `es(str)` + tiga pabrik fungsi:
 *   easeBezier(x1,y1,x2,y2)  cubicBezier — Newton 8 iter (|e|<1e-5, |e'|<1e-6),
 *                              fallback bisection 24 iter.
 *   easeElastic(damp,freq,phase,rev) — damped-spring, BUKAN cos-periode pendek:
 *        damp  = clamp(damp,.05,.9) def .5
 *        freq  = min(4, freq>.05 ? freq : 1)
 *        phase = isFinite? phase : 0
 *        lambda = -2*ln(damp)/freq      omega = 2*PI/freq
 *        raw(t) = 1 - exp(-lambda*t)*cos(omega*t + phase*2*PI)
 *        ease(t)= raw(t) + t*(1-raw(1)) - (1-t)*raw(0)
 *        rev -> 1 - ease(1-t)
 *   easeCyclic(step,smooth,pivot,end,_) — lompatan naik/turun per siklus:
 *        step  = a>0?a:.5 ; smooth = clamp(b,0,1) def 0
 *        pivot = clamp(c,.001,1) def .5 ; end = d def 0
 *        u = t%step/step
 *        u<=pivot : x=u/pivot, h=(1-cos(pi*x))/2, v=h*(1-sm)+x*sm
 *        u> pivot : x=(u-pivot)/(1-pivot), h=(1+cos(pi*x))/2,
 *                   v=h*(1-sm)+(1-x)*sm
 *        kembalikan end*t + v*(1-end*t)
 * Arity dicocokkan persis kayak di sana: cubicBezier 4, elastic 3, cyclic 5
 * (angka ke-5 cyclic diabaikan oleh preset.html sendiri — kami ikut).
 * Prefix "local " dan "reverse elastic ..." juga disangga. ================= */
const easeWarned=new Set(),easeCache=new Map();
function easeBezier(x1,y1,x2,y2){
  const a=3*x1,b=3*(x2-x1)-a,c=1-a-b;
  const A=3*y1,B=3*(y2-y1)-A,C=1-A-B;
  const bx=t=>((c*t+b)*t+a)*t,by=t=>((C*t+B)*t+A)*t,dx=t=>(3*c*t+2*b)*t+a;
  return t=>{
    if(t<=0)return 0;if(t>=1)return 1;
    let u=t;
    for(let i=0;i<8;i++){
      const e=bx(u)-t;
      if(Math.abs(e)<1e-5)return by(u);
      const d=dx(u);
      if(Math.abs(d)<1e-6)break;
      u-=e/d}
    let lo=0,hi=1;u=t;
    for(let i=0;i<24;i++){
      const e=bx(u)-t;
      if(Math.abs(e)<1e-5)break;
      if(e>0)hi=u;else lo=u;
      u=(lo+hi)/2}
    return by(u)}}
function easeElastic(damp,freq,phase,rev){
  const dm=Math.min(.9,Math.max(.05,(Number.isFinite(damp)&&damp>0)?damp:.5));
  const fq=Number.isFinite(freq)&&freq>.05?Math.min(4,freq):1;
  const ph=Number.isFinite(phase)?phase:0;
  const lam=-2*Math.log(dm)/fq,om=2*Math.PI/fq;
  const raw=t=>1-Math.exp(-lam*t)*Math.cos(om*t+ph*2*Math.PI);
  const e0=raw(0),e1=raw(1);
  const f=t=>t<=0?0:t>=1?1:raw(t)+t*(1-e1)-(1-t)*e0;
  return rev?(t=>1-f(1-t)):f}
function easeCyclic(step,smooth,pivot,end){
  const A=(Number.isFinite(step)&&step>0)?step:.5;
  const Sm=Number.isFinite(smooth)?Math.min(1,Math.max(0,smooth)):0;
  const Pv=Number.isFinite(pivot)?Math.min(1,Math.max(.001,pivot)):.5;
  const D=Number.isFinite(end)?end:0;
  return t=>{
    if(t<=0)return 0;
    if(t>=1)return D;
    let u=t%A/A;
    if(u<1e-9)u=0;
    let v;
    if(u<=Pv){
      const x=u/Pv,h=(1-Math.cos(Math.PI*x))*.5;
      v=h*(1-Sm)+x*Sm;
    }else{
      const x=(u-Pv)/(1-Pv),h=(1+Math.cos(Math.PI*x))*.5;
      v=h*(1-Sm)+(1-x)*Sm}
    const F=D*t;
    return F+v*(1-F)}}
function easeFn(spec){
  const s=String(spec||'').trim();if(!s)return null;
  if(easeCache.has(s))return easeCache.get(s);
  const tk=s.split(/\s+/);
  const head=tk[0]==='local'?tk[1]:tk[0];
  const isRev=head==='reverse'&&tk[1]==='elastic';
  const name=isRev?'elastic':head;
  const nums=tk.slice((isRev||tk[0]==='local')?2:1).map(parseFloat);
  const ok=n=>nums.length>=n&&nums.slice(0,n).every(Number.isFinite);
  let fn=null;
  if(name==='cubicBezier'&&ok(4))fn=easeBezier(nums[0],nums[1],nums[2],nums[3]);
  else if(name==='elastic'&&ok(3))fn=easeElastic(nums[0],nums[1],nums[2],isRev);
  else if(name==='cyclic'&&ok(5))fn=easeCyclic(nums[0],nums[1],nums[2],nums[3],nums[4]);
  easeCache.set(s,fn);
  return fn}
function easeQ(spec,p){
  const s=String(spec||'').trim();if(!s)return p;
  const fn=easeFn(s);
  if(fn)return fn(p);
  const tk=s.split(/\s+/);
  if(tk[0]==='linear')return p;
  if(tk[0]==='reverse')return 1-easeQ(tk.slice(1).join(' '),1-p);
  if(!easeWarned.has(s)){easeWarned.add(s);console.warn('[easing] belum diimplement, pakai linear:',s)}
  return p}
/* drawImage dengan rasio asli. mediaFillMode AM: fill/cover = jaga rasio & crop,
 * fit = jaga rasio & muat, stretch = paksa (definisi default kita: cover). */
function drawMedia(ctx,el,mode,x0,y0,w,h){
  const iw=el.videoWidth||el.naturalWidth||el.width||0,ih=el.videoHeight||el.naturalHeight||el.height||0;
  if(mode==='stretch'||!iw||!ih){ctx.drawImage(el,x0,y0,w,h);return}
  if(mode==='fit'){const s=Math.min(w/iw,h/ih),dw=iw*s,dh=ih*s;
    ctx.drawImage(el,x0+(w-dw)/2,y0+(h-dh)/2,dw,dh);return}
  const s=Math.max(w/iw,h/ih),dw=iw*s,dh=ih*s;
  ctx.save();ctx.beginPath();ctx.rect(x0,y0,w,h);ctx.clip();
  ctx.drawImage(el,x0+(w-dw)/2,y0+(h-dh)/2,dw,dh);ctx.restore()}
/* ---------------------------------------------------------------- CC gate
 * Layer coloring TIDAK bisa dikenali dari label — di lapangan namanya bebas
 * ("CC IV", "ini coloring", "ya ngentot", "punya cewe saya", ...). Jadi
 * detektornya STRUCTURAL, berdasar isi layer-nya:
 *
 *   shape  +  punya <fillColor>/<gradient>  +  TANPA fillImage/fillVideo
 *        =  balok warna solid/gradien, bukan gambar
 *
 * lalu disaring dua lapis:
 *   ukuran  size x scale  >= 40% sisi kanvas      -> pasti nutupin layar
 *   efek    ada koreksi warna (lift/satvib/vignette/replacecolor/...)
 *           DAN luas >= 10% kanvas                -> layer grading kecil
 *
 * Fill-nya JANGAN dicat (itu biang kotaknya); rantai efek tetap jalan di
 * jalur GL. Label "bg/background/latar" sengaja dikecualikan biar latar
 * scene gak ikut ilang. */
const COLOR_FX=/^(lift|satvib|vignette|replacecolor|exposure|gamma|contrast|brightness|saturation|hue|tint|levels|curves|colorbalance|colorize|duotone|sepia|color|lightness|clarity|shadows|highlights|whitetone|temperature|temp|colortune|colorcorrection)$/i;
function fxShort(e){const id=attr(e,'id','');return id.split('.').pop()}
/* ---------------------------------------------------------------- SIZE SCALE
 * AM menyimpan <property name="size"> dalam satuan PROXY 1/2 — bukan px kanvas.
 * Referensi (deobf.js):
 *     this.sizeScale = 0x2;  this.autoSizeScale = 0x2;
 *     ['setScene'](){ this.sizeScale = this.autoSizeScale;
 *       log("[SCENE] Satuan ukuran layer: x2 (AM menyimpan size dalam satuan proxy 1/2)") }
 *     ['de'](layer){ return [ size.value[0]*this.sizeScale, size.value[1]*this.sizeScale ] }
 *
 * Bukti angkanya PAS BANGET di preset uji (kanvas 1080x1920):
 *   34 layer media  size=540,960  x2            -> 1080x1920   [0..1080]x[0..1920]
 *   "jangan di ambil"/"ini coloring" 100 x 5.4,9.6 x2 -> 1080x1920
 *   "Persegi panjang 1"  100 x 9.6 x2            -> 1920x1920, y tepat 0..1920
 * Tanpa faktor ini SEMUA layer jadi setengah ukuran -> preview bolong di
 * segala penjuru ("ga penuh, masih banyak bagian kosong").
 *
 * Catatan: ini HANYA utk <property name="size">. Atribut size di <text>
 * (font-size) lewat attr(l,'size') dan TIDAK boleh dikali 2. */
const AM_SIZE_SCALE = 2;
function amSize(l,t,def){
  const s=vec(value(l,'size',t,def));
  return [s[0]*AM_SIZE_SCALE, s[1]*AM_SIZE_SCALE];
}
function ccBox(l){
  /* (size x AM_SIZE_SCALE) x <scale> transform -> px efektif di kanvas.
   * Contoh: size 100 x 2 x scale 5.4 = 1080px (lebar penuh kanvas 1080). */
  const sx=[...l.children].find(x=>x.tagName==='transform');
  const sc=vec(sx?value(sx,'scale',0,'1,1'):'1,1');
  const sz=amSize(l,0,'100,100');
  return [Math.abs(sz[0]*sc[0]),Math.abs(sz[1]*sc[1])]}
function ccReason(l){
  if(!l)return '';
  const lab=attr(l,'label','');
  if(/^cc\b/i.test(lab))return 'label';                 /* CC I / CC IV */
  if(/colou?r(ing|s)?|warna|grading/i.test(lab))return 'label';
  if(/^(bg|background|latar)\b/i.test(lab))return '';    /* latar: jangan */
  if(l.tagName!=='shape')return '';
  if(l.getAttribute('fillImage')||l.getAttribute('fillVideo'))return '';
  /* fillType=color/gradient TANPA <fillColor> juga termasuk — itu layer
   * adjustment ("ya ngentot"): fill-nya kosong, tapi efeknya (vignette/
   * gradientoverlay) nembak warna sendiri di atas tekstur kosong -> balok. */
  const ft=attr(l,'fillType','');
  const hasFill=!!(l.querySelector('fillColor')||l.querySelector('gradient'));
  if(!hasFill&&ft!=='color'&&ft!=='gradient')return '';
  const fx=[...l.children].filter(x=>x.tagName==='effect');
  const colorFx=fx.some(e=>COLOR_FX.test(fxShort(e)));
  const sx=[...l.children].find(x=>x.tagName==='transform');
  const sc=vec(sx?value(sx,'scale',0,'1,1'):'1,1'),sz=amSize(l,0,'100,100');
  const w=Math.abs(sz[0]*sc[0]),h=Math.abs(sz[1]*sc[1]);
  const covers=!!(scene&&w>=scene.w*.4&&h>=scene.h*.4);
  const opEl=sx&&sx.querySelector('opacity');
  const op=num(value(sx,'opacity',0,'1'));
  const opAnim=!!(opEl&&opEl.querySelector('kf'));
  const bl=attr(l,'blending','');
  /* gradasi polos TANPA SATUPUN efek -> elemen dekoratif (mis. "Persegi
   * panjang 1"), jangan disentuh walaupun seukuran layar. Layer coloring
   * selalu bawa efek (lift/exposure/vignette/replacecolor/...), jadi syarat
   * "fx.length===0" ini ngebedain mereka cukup tajam. */
  if(ft==='gradient'&&!fx.length&&!colorFx)return '';
  if(covers)return 'ukuran';                            /* nutupin layar */
  if(colorFx)return 'efek';                             /* grading warna */
  if(bl&&bl!=='normal')return 'blend';                  /* mode campur */
  if(op<1||opAnim)return 'opacity';                     /* overlay transparan */
  return ''}
function ccNoFill(l){return !!ccReason(l)}

function value(parent,name,t,def){
  const e=parent&&[...parent.children].find(x=>(x.tagName==='property'&&x.getAttribute('name')===name)||x.tagName===name);
  if(!e)return def;
  /* AM tidak menjamin <kf> terurut; tanpa sortir pasangan rentang jadi balik */
  const k=[...e.children].filter(x=>x.tagName==='kf').sort((p,q)=>num(p.getAttribute('t'))-num(q.getAttribute('t')));
  if(!k.length)return e.getAttribute('value')??def;
  const T=x=>num(x.getAttribute('t'));
  if(t<=T(k[0]))return String(k[0].getAttribute('v')??def);            // tahan yang pertama
  if(t>=T(k[k.length-1]))return String(k[k.length-1].getAttribute('v')??def); // tahan yang terakhir
  let a=k[0],b=k[1];
  for(let p=0;p<k.length-1;p++){if(t>=T(k[p])&&t<=T(k[p+1])){a=k[p];b=k[p+1];break}}
  const span=T(b)-T(a),pr=span>0?clamp((t-T(a))/span,0,1):0;
  const q=easeQ(a.getAttribute('e'),pr);
  const av=vec(a.getAttribute('v')),bv=vec(b.getAttribute('v'));
  return av.map((x,i)=>x+(bv[i]-x)*q).join(',')
}
/* ---------- affine 2D, konvensi canvas: [a,b,c,d,e,f] --------------------
 *  x' = a*x + c*y + e ;  y' = b*x + d*y + f
 *  mMul(A,B) = A lalu B (B dijalankan duluan) — persis urutan ctx.*(). */
const mMul=(A,B)=>[A[0]*B[0]+A[2]*B[1],A[1]*B[0]+A[3]*B[1],
                   A[0]*B[2]+A[2]*B[3],A[1]*B[2]+A[3]*B[3],
                   A[0]*B[4]+A[2]*B[5]+A[4],A[1]*B[4]+A[3]*B[5]+A[5]];
/* T(pos) * R(rot) * S(scale) — urutan yang dipakai deobf `xe()` */
function mTRS(p,deg,sc){
  const r=deg*Math.PI/180,c=Math.cos(r),s=Math.sin(r);
  return [c*sc[0],s*sc[0],-s*sc[1],c*sc[1],p[0],p[1]];
}
/* balik affine -> mat3 kolom-major utk GLSL (col-major: [a,b,0, c,d,0, e,f,1]) */
function mInv(m){
  const a=m[0],b=m[1],c=m[2],d=m[3],e=m[4],f=m[5],det=a*d-b*c;
  const k=Math.abs(det)<1e-9?0:1/det;
  return new Float32Array([d*k,-b*k,0, -c*k,a*k,0, (c*f-d*e)*k,(b*e-a*f)*k,1]);
}
/* tr(layer, tNorm, tAbsMs) -> transform layer + rantai <embedScene>/<group>.
 *   q.m   : affine lengkap luar..dalam * layer  (untuk ctx.transform / GL)
 *   q.mop : opacity TOTAL (layer x tiap induk)
 *   q.ok  : false kalau salah satu induk di luar jendela waktunya / hidden
 * tAbsMs WAJIB diisi pemanggil (draw, drawDebug, glscene.render) karena
 * jendela startTime/endTime induk dihitung dalam milidetik absolut. */
function tr(l,t,tAbs){
  const x=[...l.children].find(e=>e.tagName==='transform');
  const q={pos:vec(value(x,'location',t,'0,0')),scale:vec(value(x,'scale',t,'1,1')),
           rot:num(value(x,'rotation',t,'0')),opacity:num(value(x,'opacity',t,'1'))};
  let m=mTRS(q.pos,q.rot,q.scale),op=q.opacity,ok=true;
  const ch=l.__chain;
  if(ch&&ch.length){
    const hasAbs=typeof tAbs==='number'&&scene;
    for(let i=ch.length-1;i>=0;i--){
      const e=ch[i];
      /* jendela waktu induk: Group 4 di preset user mulai tampil di 1633ms */
      let et;
      if(hasAbs){
        const a=num(attr(e,'startTime',0)),b=num(attr(e,'endTime',scene.duration));
        if(tAbs<a||tAbs>b||attr(e,'hidden','')==='true'){ok=false;break}
        et=clamp((tAbs-a)/(b-a||1),0,1);
      }else et=t;   /* pemanggil tanpa tAbs: tetap komposisi, tanpa gating */
      const y=[...e.children].find(z=>z.tagName==='transform');
      m=mMul(mTRS(vec(value(y,'location',et,'0,0')),num(value(y,'rotation',et,'0')),
                  vec(value(y,'scale',et,'1,1'))),m);
      op*=clamp(num(value(y,'opacity',et,'1')),0,1);
    }
  }
  q.m=m;q.mop=op;q.ok=ok;q.nch=ch?ch.length:0;
  return q;
}
function parse(text){const d=new DOMParser().parseFromString(text,'application/xml');if(d.querySelector('parsererror')||d.documentElement.tagName!=='scene')throw Error('XML tidak valid: root harus <scene>');const r=d.documentElement,layers=flatten(r);scene={root:r,layers,w:num(attr(r,'width',1080),1080),h:num(attr(r,'height',1920),1920),fps:num(attr(r,'fps',30),30),duration:num(attr(r,'totalTime',2000),2000)};canvas.width=scene.w;canvas.height=scene.h;mediaSlots=layers.filter(x=>x.getAttribute('fillVideo')||x.getAttribute('fillImage')).map((layer,i)=>({layer,name:attr(layer,'label',`Media ${i+1}`),file:null}));audioTracks=[...r.children].filter(x=>x.tagName==='audio').map((layer,i)=>({layer,name:attr(layer,'label',`Audio ${i+1}`),file:null,audio:null}));renderUi();renderEffects();draw(0);$('empty').classList.add('hidden');$('playBtn').disabled=false;$('timeline').disabled=false;$('exportBtn').disabled=false;$('timeline').max=scene.duration;status(`Loaded · ${layers.length} layers · ${mediaSlots.length} media slots`)}
function renderUi(){const title=$('projectTitle');if(title)title.textContent=attr(scene.root,'title','Untitled');const meta=$('projectMeta');if(meta)meta.textContent=`${scene.w} × ${scene.h} · ${scene.fps} fps · ${fmt(scene.duration)}`;const projectInfo=$('projectInfo');if(projectInfo)projectInfo.innerHTML=`Title: ${attr(scene.root,'title','—')}<br>Duration: ${fmt(scene.duration)}<br>Format: AM ${attr(scene.root,'amver','—')}`;$('layerCount').textContent=scene.layers.length;$('mediaCount').textContent=mediaSlots.length;$('audioCount').textContent=audioTracks.length;const layerList=$('layers');if(layerList)layerList.innerHTML=scene.layers.map((l,i)=>`<div class="layer-row${attr(l,'hidden','')==='true'?' off':''}"><span class="layer-icon">${l.tagName==='text'?'T':l.getAttribute('fillVideo')?'▣':'◇'}</span><span>${attr(l,'label',`${l.tagName} ${i+1}`)}</span><button class="eye${attr(l,'hidden','')==='true'?' is-off':''}" data-eye="${i}" title="${attr(l,'hidden','')==='true'?'Tampilkan layer ini':'Sembunyikan layer ini'}">${attr(l,'hidden','')==='true'?'Tampil':'Sembunyi'}</button></div>`).join('');const mediaList=$('mediaList');if(mediaList)mediaList.innerHTML=mediaSlots.length?mediaSlots.map((s,i)=>`<div class="slot"><span class="layer-icon">▣</span><b>${s.file?.name||s.name}</b><button data-media="${i}">${s.file?'Ganti':'Pilih'}</button></div>`).join(''):'<div class="muted">Tidak ada media slot</div>';const audioList=$('audioList');if(audioList)audioList.innerHTML=audioTracks.length?audioTracks.map((s,i)=>`<div class="slot"><span>♫</span><b>${s.file?.name||s.name}</b><button data-audio="${i}">${s.file?'Ganti':'Pilih'}</button></div>`).join(''):'<div class="muted">Tidak ada audio layer</div>';const timelineCount=$('timelineCount');if(timelineCount)timelineCount.textContent=`${scene.layers.length} layers`;const timelineRows=$('timelineRows');if(timelineRows)timelineRows.innerHTML=scene.layers.map((l,i)=>{const a=num(attr(l,'startTime',0)),b=num(attr(l,'endTime',scene.duration));return`<div class="tl-row${attr(l,'hidden','')==='true'?' off':''}"><span class="tl-label">${attr(l,'label',l.tagName)}</span><span class="tl-bar" style="width:${Math.max(2,(b-a)/scene.duration*70)}%"></span><button class="eye tl-eye${attr(l,'hidden','')==='true'?' is-off':''}" data-eye="${i}" title="${attr(l,'hidden','')==='true'?'Tampilkan layer ini':'Sembunyikan layer ini'}">${attr(l,'hidden','')==='true'?'Tampil':'Sembunyi'}</button></div>`}).join('')}
function loadMedia(file,slot){const el=file.kind==='video'?document.createElement('video'):new Image();if(file.kind==='video'){el.muted=true;el.playsInline=true;el.preload='auto'}const m={element:el,kind:file.kind,ready:false};const done=()=>{m.ready=true;draw(offset)};el.onload=done;el.onloadeddata=done;el.onerror=()=>toast(`Gagal memuat ${file.name}`);el.src=file.url;mediaMap.set(file.url,m);slot.file=file;renderUi()}
function attachShareMedia(media,manifest){
  if(!scene)return 0;
  const keys=Object.keys(media||{});if(!keys.length)return 0;
  const byBase={},byName={};
  for(const k of keys){const b=k.split('/').pop().toLowerCase();byBase[b]=k;byName[k.toLowerCase()]=k}
  const sha={};String(manifest||'').split('\n').forEach(l=>{const m=l.match(/^\s*([0-9a-fA-F]{40}):(.+?)\s*$/);if(m)sha[m[1].toUpperCase()]=m[2]});
  const uri={};[...scene.root.children].forEach(e=>{if(e.tagName==='media'&&e.hasAttribute('uri'))uri[e.getAttribute('uri')]=e.getAttribute('filename')||''});
  const pick=n=>{if(!n)return null;const s=String(n).replace(/^\.\//,'');if(media[s])return media[s];
    const b=s.split('/').pop().toLowerCase();
    if(byBase[b])return media[byBase[b]];
    if(byName[b])return media[byName[b]];
    return null};
  const find=ref=>{
    if(!ref)return null;
    if(/^(data|blob|https?):/i.test(ref))return ref;
    const raw=String(ref).trim();let n=raw;
    const sc=raw.match(/^([a-z][a-z0-9+.-]*):(.*)$/i);
    if(sc){n=sc[2];if(n.startsWith('//'))n=n.slice(2)}
    if(uri[raw]){const p=pick(uri[raw]);if(p)return p}
    const hit=pick(n);if(hit)return hit;
    const stem=n.split('/').pop().replace(/\.[^.]+$/,'').toUpperCase();
    if(/^[0-9A-F]{40}$/.test(stem)&&sha[stem]){const p=pick(sha[stem]);if(p)return p}
    const m2=raw.match(/([0-9a-fA-F]{40})/);
    if(m2&&sha[m2[1].toUpperCase()]){const p=pick(sha[m2[1].toUpperCase()]);if(p)return p}
    return null;
  };
  let n=0;const miss=[];
  for(const s of mediaSlots){
    const ref=s.layer.getAttribute('fillVideo')||s.layer.getAttribute('fillImage');
    const url=find(ref);
    if(!url){s.missing=!!ref;if(ref)miss.push(ref);continue}
    s.missing=false;
    const kind=/\.(mp4|m4v|webm|mov|mkv)$/i.test(url)?'video':'image';
    loadMedia({url,kind,name:url.split('/').pop(),path:url},s);n++;
  }
  for(const s of audioTracks){
    const ref=s.layer.getAttribute('src');
    const url=find(ref);
    if(!url){s.missing=!!ref;if(ref)miss.push(ref);continue}
    s.missing=false;
    s.file={path:url,url,kind:'audio',name:url.split('/').pop(),size:0};renderUi();n++;
  }
  const missN=miss.length;
  if(n)toast(`Share: ${n} media terpasang${missN?` · ${missN} aset tak ada di paket`:''}`);
  if(missN)console.warn('[share] media tak terpetakan:',miss.slice(0,20));
  return n;
}


/* AM `blending` -> globalCompositeOperation (mirror BLEND[] di glscene.js).
 * Padanan canvas2D yang aman saja. `subtract`/`linear-burn` tidak ada di canvas;
 * `mask` butuh destination-in yang BISA menghapus seluruh kanvas di luar region
 * sumber -> sengaja dibiarkan source-over. Mode eksotis ditangani jalur WebGL. */
/* `ms` dari preset.html — DIPINDAH VERBATIM.
 * Catatan kesadaran: preset.html TIDAK punya color/saturation/hue/luminosity di
 * sini, jadi mode2 itu jatuh ke source-over (ms[mode] || "source-over").
 * `exclude` di sana = destination-out, bukan exclusion — itu beda hal. */
const B2D={
  'normal':'source-over','mask':'destination-in','mask-fill':'source-over',
  'mask-exclude':'destination-out','exclude':'destination-out',
  'multiply':'multiply','screen':'screen',
  'add':'lighter','plus':'lighter','linear-dodge':'lighter',
  'overlay':'overlay','soft-overlay':'overlay','soft-light':'soft-light',
  'darken':'darken','lighten':'lighten',
  'difference':'difference','exclusion':'exclusion'};
/* createLinearGradient dari <gradient start end startColor endColor>.
 * Koordinat ternormalisasi (0..1) terhadap ukuran layer, dipusatkan:
 *   P(v,k,sc) = v[k]*sc - sc/2
 * (sebelumnya dipanggil tapi TIDAK PERNAH didefinisikan -> ReferenceError
 *  yang mematikan jalur fallback 2D tiap kali ketemu layer <gradient>.) */
function makeGrad(ctx,g,size){
  const st=vec(g.getAttribute('start')||'0,0'),en=vec(g.getAttribute('end')||'0,1');
  const P=(v,k,sc)=>((v.length>k?v[k]:0)*sc)-sc/2;
  const gr=ctx.createLinearGradient(P(st,0,size[0]),P(st,1,size[1]),
                                    P(en,0,size[0]),P(en,1,size[1]));
  gr.addColorStop(0,color(g.getAttribute('startColor')||'#ffffffff'));
  gr.addColorStop(1,color(g.getAttribute('endColor')||'#ff000000'));
  return gr}
/* ?debug=1 -> outline tiap layer yang DIGAMBAR, plus label+index.
 * Merah  = layer CC (fill ditahan, efek jalan)
 * Hijau  = layer biasa (fill digambar)
 * Kalau ada kotak solid TANPA outline di sekelilingnya -> box itu BUKAN layer
 * (background / artefak), bukan CC. */
var DBG=/[?&]debug=1/.test(location.search);
function drawDebug(time){
  if(!scene)return;
  ctx.save();
  ctx.setTransform(1,0,0,1,0,0);
  ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';
  const seen=[],cov=[];
  for(let i=0;i<scene.layers.length;i++){
    const l=scene.layers[i];
    const a=num(attr(l,'startTime',0)),b=num(attr(l,'endTime',scene.duration));
    if(time<a||time>b)continue;
    const t=clamp((time-a)/(b-a||1),0,1),q=tr(l,t,time);
    if(!q.ok)continue;                                   /* induk hidden / di luar jendela */
    const size=amSize(l,t,'300,300');
    const gated=ccNoFill(l);
    const col=gated?'#ff4d6d':'#38f0c0';
    const cx=q.m[4],cy=q.m[5];                           /* pusat layer sesudah rantai */
    ctx.save();
    ctx.transform(q.m[0],q.m[1],q.m[2],q.m[3],q.m[4],q.m[5]);
    ctx.lineWidth=6/(Math.abs(q.scale[0])+Math.abs(q.scale[1])||1);
    ctx.strokeStyle=col;
    ctx.strokeRect(-size[0]/2,-size[1]/2,size[0],size[1]);
    ctx.restore();
    ctx.save();
    ctx.font='14px ui-monospace,monospace';ctx.textAlign='left';
    ctx.fillStyle=col;
    ctx.fillText((gated?'[cc:'+ccReason(l)+'] ':'')+i+' '+attr(l,'label',l.tagName),
                 cx+8,cy-8);
    ctx.restore();
    seen.push(i+'|'+(attr(l,'label')||l.tagName)+(q.nch?'|chain'+q.nch:'')+'|'+(gated?'cc:'+ccReason(l):'fill'));
    /* LAPORAN PENUTUP: bentang >=90% durasi DAN menutupi kanvas.
     * Kalau kotak solid tapi semua outline HIJAU -> biangnya ada di daftar ini. */
    const sx=Math.hypot(q.m[0],q.m[1]),sy=Math.hypot(q.m[2],q.m[3]);
    const sw=Math.abs(size[0]*sx),sh=Math.abs(size[1]*sy);
    if((b-a)>=scene.duration*0.9&&sw>=scene.w*0.95&&sh>=scene.h*0.95)
      cov.push((gated?'cc['+ccReason(l)+'] ':'#')+i+' '+attr(l,'label',l.tagName)
        +' fill='+(l.getAttribute('fillImage')?'media':(attr(l,'fillType','')||'color'))
        +' dur='+Math.round((b-a)/scene.duration*100)+'%');
  }
  if(cov.length){
    ctx.save();
    ctx.setTransform(1,0,0,1,0,0);
    ctx.font='15px ui-monospace,monospace';ctx.textAlign='left';
    ctx.fillStyle='rgba(0,0,0,.72)';
    ctx.fillRect(6,6,Math.min(scene.w-12,760),22+17*cov.length);
    ctx.fillStyle='#ffb020';
    ctx.fillText('KANDIDAT PENUTUP ('+cov.length+')  -- catat nomornya:',14,25);
    ctx.fillStyle='#ffe08a';
    for(let i=0;i<cov.length&&i<8;i++)ctx.fillText('  '+cov[i],14,44+17*i);
    ctx.restore();
  }
  ctx.restore();
  if(!drawDebug._log){drawDebug._log=1;
    console.log('[debug] layer terlihat:',seen);
    console.log('[debug] KANDIDAT PENUTUP:',cov);}
}
function draw(time){
  if(!scene)return;
  ctx.clearRect(0,0,scene.w,scene.h);
  ctx.fillStyle=color(attr(scene.root,'bgcolor','#ff000000'));
  ctx.fillRect(0,0,scene.w,scene.h);
  for(const l of scene.layers){
    const a=num(attr(l,'startTime',0)),b=num(attr(l,'endTime',scene.duration));
    if(time<a||time>b)continue;
    if(attr(l,'hidden','')==='true')continue;   /* reference: l.hidden -> return */
    const t=clamp((time-a)/(b-a||1),0,1),q=tr(l,t,time);
    if(!q.ok)continue;                                   /* induk hidden / di luar jendela */
    const slot=mediaSlots.find(s=>s.layer===l);
    if(slot&&slot.missing)continue;                       /* aset tak ada di paket */
    if(ccNoFill(l))continue;                              /* CC: isi fill ditahan */
    const size=amSize(l,t,'300,300');
    const m=slot?.file&&mediaMap.get(slot.file.url);
    ctx.save();
    ctx.globalAlpha=clamp(q.mop,0,1);                     /* opacity layer x induk */
    const bl=B2D[String(attr(l,'blending','')).toLowerCase()];
    if(bl)ctx.globalCompositeOperation=bl;   /* ctx.save/restore balikin sendiri */
    ctx.transform(q.m[0],q.m[1],q.m[2],q.m[3],q.m[4],q.m[5]);
    const x0=-size[0]/2,y0=-size[1]/2;
    if(l.getAttribute('fillVideo')||l.getAttribute('fillImage')){
      if(m?.ready)drawMedia(ctx,m.element,l.getAttribute('mediaFillMode'),x0,y0,size[0],size[1]);
      else if(slot){ctx.fillStyle='#20263a';ctx.fillRect(x0,y0,size[0],size[1]);ctx.fillStyle='#9aa4c0';ctx.font='16px sans-serif';ctx.textAlign='center';ctx.fillText('Pilih media',0,0)}
    }else if(l.tagName==='text'){
      const fs=num(attr(l,'size',48)),cn=l.querySelector('content');
      ctx.fillStyle=color(attr(l.querySelector('fillColor'),'value','#ffffffff'));
      ctx.font=`${fs}px sans-serif`;ctx.textAlign=attr(l,'align','left');
      for(const [i,s] of (cn?.textContent||'').split('\n').entries())ctx.fillText(s,0,i*fs*1.2);
    }else{
      /* tanpa fillColor DAN tanpa gradient -> layer adjustment, HARUS transparan */
      const g=l.querySelector('gradient'),fc=l.querySelector('fillColor');
      if(g){ctx.fillStyle=makeGrad(ctx,g,size);ctx.fillRect(x0,y0,size[0],size[1])}
      else if(fc){ctx.fillStyle=color(fc.getAttribute('value')||'#ffffffff');ctx.fillRect(x0,y0,size[0],size[1])}
    }
    ctx.restore();
  }
  $('timeline').value=time;
  $('timeLabel').textContent=`${fmt(time)} / ${fmt(scene.duration)}`
  if(DBG)drawDebug(time);
}

function audioSync(time,play){
  const mute=$('muteAudio').checked;
  for(const s of audioTracks){
    if(!s.file)continue;
    if(!s.audio){s.audio=new Audio(s.file.url);s.audio.preload='auto'}
    if(mute||!play){s.audio.pause();continue}
    const target=Math.max(0,time/1000+num(attr(s.layer,'inTime',0))/1000);
    const now=(window.performance&&performance.now())||Date.now();
    /* drifter >0.8s baru dikoreksi, dan maksimal tiap 600ms — kalau tidak,
       frame yang lambat bikin seek tiap rAF -> audio ngulang-ngulang */
    if(s.audio.readyState>=2&&Math.abs(s.audio.currentTime-target)>.8&&(!s.lastSeek||now-s.lastSeek>600)){
      s.lastSeek=now;
      try{s.audio.currentTime=target}catch(e){}
    }
    const p=s.audio.play();
    if(p&&p.catch)p.catch(()=>{});
  }
}
function tick(now){if(!playing)return;const t=offset+(now-started)*num($('speed').value,1);if(t>=scene.duration){if(loop){offset=0;started=now}else{playing=false;offset=scene.duration;$('playBtn').textContent='▶';audioSync(offset,false)}}draw(clamp(t,0,scene.duration));audioSync(t,true);raf=requestAnimationFrame(tick)}function toggle(){if(!scene)return;if(playing){playing=false;offset=num($('timeline').value);cancelAnimationFrame(raf);$('playBtn').textContent='▶';audioSync(offset,false)}else{playing=true;started=performance.now();offset=num($('timeline').value);$('playBtn').textContent='Ⅱ';audioSync(offset,true);raf=requestAnimationFrame(tick)}}
async function openProject(){const p=await window.desktop.openFile();if(!p)return;try{const r=await window.desktop.readFile(p);parse(r.scenes[0].text)}catch(e){toast(e.message);status(e.message)}}async function pickMedia(slot){const f=(await window.desktop.openMedia()).find(x=>x.kind==='image'||x.kind==='video');if(f)loadMedia(f,slot)}async function pickAudio(slot){const f=(await window.desktop.openMedia()).find(x=>x.kind==='audio');if(f){slot.file=f;renderUi();toast(`Audio: ${f.name}`)}}
/* ========================= panel Efek (inspector) =========================
 * effects.json = {byId:{fullid:short}, effects:[{id,type,name,shaders,params}]}
 * shaders[].src = path GLSL relatif ke /webfx/ -> di-fetch on demand (file terpisah,
 * bukan simpenan di JSON), jadi kodenya ditarik pas tombol "Lihat kode" diklik. */
let FXDB=null;
fetch('/webfx/effects.json').then(x=>x.json()).then(d=>{FXDB=d;if(scene)renderEffects()}).catch(()=>{});
function esc(s){return String(s??'').replace(/[&<>"]/g,k=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[k]))}
function copyText(s,btn){
  const done=()=>{const o=btn.textContent;btn.textContent='Tersalin \u2713';setTimeout(()=>{btn.textContent=o},1200)};
  const fb=()=>{const t=document.createElement('textarea');t.value=s;t.style.position='fixed';t.style.opacity='0';
    document.body.appendChild(t);t.select();try{document.execCommand('copy')}catch(e){}document.body.removeChild(t);done()};
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(s).then(done,fb);else fb()}
function fxVal(p,e){
  const n=p.getAttribute('name'),kf=p.children.length;
  /* value() udah ngerti <property> + <kf> + easing -> tampilin nilai DI playhead,
     bukan cuma angka statis yang kadang udah kelewat sama keyframe-nya */
  let v=(typeof offset==='number')?value(e,n,offset,undefined):undefined;
  if(v===undefined||v==='')v=p.getAttribute('value')??'';
  return kf?v+' \u23f1\u2009'+kf+'kf':v}
function renderEffects(){
  const box=$('effectList'),cnt=$('fxCount');if(!box)return;
  if(!scene){box.innerHTML='<div class="muted">Belum ada project</div>';if(cnt)cnt.textContent='0';return}
  const byId=FXDB?Object.fromEntries(FXDB.effects.map(e=>[e.id,e])):{};
  const out=[];let n=0;
  scene.layers.forEach((l,i)=>{
    const fx=[...l.children].filter(x=>x.tagName==='effect');
    if(!fx.length)return;
    n+=fx.length;
    out.push('<div class="fx-layer">#'+i+' \u00b7 '+esc(attr(l,'label',l.tagName))
      +' <span class="muted">('+fx.length+' efek)</span></div>');
    fx.forEach(e=>{
      const id=attr(e,'id',''),meta=byId[id],short=id.split('.').pop();
      const params=[...e.children].filter(x=>x.getAttribute&&x.getAttribute('name'));
      const g=(meta&&meta.shaders&&meta.shaders[0]&&meta.shaders[0].src)||'';
      out.push('<div class="fx-item"><div class="fx-head">'
        +'<span class="fx-id">'+esc(short||'(tanpa id)')+'</span>'
        +'<span class="fx-name">'+esc(meta?meta.name:'? tak dikenal')+'</span>'
        +(meta?'<span class="muted">'+meta.type+'</span>':'')
        +(e.getAttribute('locallyApplied')==='true'?'<span class="muted">local</span>':'')
        +'<span class="fx-acts">'
        +'<button class="fx-btn" data-fx="id" data-v="'+esc(id)+'">Copy id</button>'
        +(g?'<button class="fx-btn" data-fx="glsl" data-v="'+esc('/webfx/'+g)+'">Lihat kode</button>':'')
        +'</span></div>'
        +(params.length?'<div class="fx-params">'+params.map(p=>esc(p.getAttribute('name'))+' = '+esc(fxVal(p,e))).join('  \u00b7  ')+'</div>':'')
        +'<pre class="fx-pre" hidden></pre></div>')});
  });
  box.innerHTML=out.length?out.join(''):'<div class="muted">Tidak ada layer berefek</div>';
  if(cnt)cnt.textContent=n}
$('effectList').addEventListener('click',async e=>{
  const b=e.target.closest('button[data-fx]');if(!b)return;
  const pre=b.closest('.fx-item').querySelector('.fx-pre');
  if(b.dataset.fx==='id'){copyText(b.dataset.v,b);return}
  if(b.dataset.fx==='copy'){copyText(b._code||'',b);return}
  if(b.dataset.fx==='glsl'){
    if(!pre.hidden){pre.hidden=true;b.textContent='Lihat kode';return}
    pre.textContent='Memuat GLSL\u2026';pre.hidden=false;b.textContent='Sembunyikan';
    try{
      const res=await fetch(b.dataset.v);
      if(!res.ok)throw Error(res.status+' '+b.dataset.v);
      const t=await res.text();pre.textContent=t;
      let cb=pre.querySelector('.fx-btn');
      if(!cb){cb=document.createElement('button');cb.className='fx-btn';cb.dataset.fx='copy';pre.appendChild(cb)}
      cb._code=t;cb.textContent='Copy kode';
    }catch(err){pre.textContent='Gagal memuat: '+err.message}}});
function fxRefresh(){const p=document.querySelector('.pane[data-pane="effects"]');
  if(p&&p.classList.contains('active')&&typeof renderEffects==='function')renderEffects()}
/* ================= toggle tampil/sembunyi layer — PER LAYER =================
 * Tiap baris punya tombolnya sendiri: yang dimatiin cuma layer itu.
 *   klik biasa      -> toggle layer itu doang
 *   Alt/Shift+klik  -> SOLO, cuma layer itu yang tampil (sisanya mati)
 * Sama-sama nulis atribut `hidden` yang dibaca dua loop gambar
 * (renderer.draw:288 + glscene.render:616) -> jalur 2D & GL ikut, logika gak dobel.
 * glscene.render() clear FBO tiap frame, jadi frame-nya dijamin bersih. */
function eyeToggle(i,solo){
  if(!scene)return;
  const l=scene.layers[i];if(!l)return;
  const nm=`#${i} ${attr(l,'label',l.tagName)}`;
  if(solo){
    const on=l.getAttribute('hidden')==='true';
    scene.layers.forEach((x,j)=>{
      if(j===i)x.removeAttribute('hidden');
      else if(!on)x.setAttribute('hidden','true');
      else x.removeAttribute('hidden')});
    status(on?`Solo ${nm} dilepas`:`Solo: cuma ${nm} yang tampil`);
  }else{
    const was=l.getAttribute('hidden')==='true';
    if(was)l.removeAttribute('hidden');else l.setAttribute('hidden','true');
    status(`${nm} ${was?'ditampilkan':'disembunyiin'}`);
  }
  renderUi();draw(offset)}
function eyeClick(e){
  const b=e.target.closest('button[data-eye]');if(!b||!scene)return;
  eyeToggle(Number(b.dataset.eye),e.altKey||e.shiftKey)}
['layers','timelineRows'].forEach(id=>{const el=$(id);if(el)el.addEventListener('click',eyeClick)});
$('hideAll').onclick=()=>{scene.layers.forEach(l=>l.setAttribute('hidden','true'));
  renderUi();draw(offset);status('Semua layer disembunyikan')};
$('showAll').onclick=()=>{scene.layers.forEach(l=>l.removeAttribute('hidden'));
  renderUi();draw(offset);status('Semua layer tampil')};
$('openBtn').onclick=openProject;$('paneOpen').onclick=openProject;$('emptyOpen').onclick=openProject;$('playBtn').onclick=toggle;$('restart').onclick=()=>{offset=0;draw(0);audioSync(0,false)};$('loopBtn').onclick=()=>{loop=!loop;$('loopBtn').classList.toggle('on',loop)};$('timeline').oninput=e=>{offset=num(e.target.value);draw(offset);audioSync(offset,false);fxRefresh()};document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x===b));document.querySelectorAll('.pane').forEach(x=>x.classList.toggle('active',x.dataset.pane===b.dataset.tab))});$('mediaList').onclick=e=>{const i=e.target.closest('button')?.dataset.media;if(i!==undefined)pickMedia(mediaSlots[Number(i)])};$('audioList').onclick=e=>{const i=e.target.closest('button')?.dataset.audio;if(i!==undefined)pickAudio(audioTracks[Number(i)])};$('addMedia').onclick=async()=>{for(const f of (await window.desktop.openMedia()).filter(x=>x.kind==='image'||x.kind==='video')){const slot=mediaSlots.find(x=>!x.file);if(!slot)break;loadMedia(f,slot)}};$('addAudio').onclick=async()=>{const f=(await window.desktop.openMedia()).find(x=>x.kind==='audio');if(f){if(!audioTracks.length)audioTracks.push({layer:scene.root.ownerDocument.createElement('audio'),name:f.name,file:f,audio:null});else audioTracks[0].file=f;renderUi()}};$('muteAudio').onchange=()=>audioSync(offset,false);
/* Status GL setelah import. Menulis ke #glState (elemen khusus) supaya tidak
 * pernah menimpa metadata project. Dipanggil dari finally, bukan try. */
function glReport(){
  const el=$('glState');if(!el)return;
  const G=window.GLScene;
  if(!G||!G.stats){el.textContent='GL belum siap';el.className='off';
    console.log('[glReport] GLScene/stats belum tersedia');return}
  const s=G.stats,brk=G.broken?Object.keys(G.broken()||{}).length:0;
  let txt=(s.gl?'GL aktif':'fallback 2D')+(s.ready?'':' (menyiapkan)')+
    ' \u00b7 '+(s.fx||0)+' fx ('+brk+' rusak, '+(s.missing||0)+' hilang)'+
    ' \u00b7 '+Math.round(s.ms||0)+'ms'+
    (s.cc ? ' \u00b7 cc '+s.cc : '')+
    ((s.skipped||0) ? ' \u00b7 skip '+s.skipped : '')+
    ((s.chain||0) ? ' \u00b7 chain '+s.chain : '');   /* layer di dalam <embedScene>/<group> */
  el.textContent=txt;el.className=(s.gl&&s.ready)?'on':'off';
  console.log('[glReport]',txt,s);
}
console.log('[build] ccB6');if($('glState'))$('glState').textContent='build ccB6';
$('loadUrlBtn').onclick=()=>$('modal').classList.remove('hidden');$('closeModal').onclick=$('cancelUrl').onclick=()=>$('modal').classList.add('hidden');$('fetchUrl').onclick=async()=>{const box=$('shareInfo');const btn=$('fetchUrl');box.classList.remove('hidden');btn.disabled=true;box.textContent='Mengunduh paket… bisa 60–120 detik, jangan ditutup.';try{const r=await window.desktop.resolveShare($('urlInput').value.trim());box.textContent=r.metadata.title+(r.metadata.projectCount?` — ${r.metadata.projectCount} project`:'')+(r.metadata.description?' · '+r.metadata.description:'');if(r.scenes){parse(r.scenes[0].text);if(r.media)attachShareMedia(r.media,r.manifest)}}catch(e){box.textContent='⚠ '+e.message}finally{btn.disabled=false;setTimeout(glReport,3000)}};$('exportBtn').onclick=()=>toast('Export belum diaktifkan pada runtime v1');
window.addEventListener('error',e=>{console.error(e.error||e.message);toast(e.message)});window.addEventListener('unhandledrejection',e=>{console.error(e.reason);toast(e.reason?.message||'Runtime error')});
