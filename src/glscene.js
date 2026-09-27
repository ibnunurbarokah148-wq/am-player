/* =============================================================================
 * glscene.js — WebGL scene renderer for am-player (milestone M2)
 *
 * Replaces the 2D-canvas path of renderer.js for every frame while a scene is
 * loaded. Per layer:
 *
 *   1. rasterize the layer content (shape / text / media) into a small offscreen
 *      2D canvas, centred on the layer anchor  -> matches renderer.js drawing
 *   2. upload it to a GL texture                (__layer__ target)
 *   3. run its <effect> children in order       (AMFX.Engine.renderSync)
 *      - shader effects  : packed GLSL from webfx/
 *      - native effects  : one builtin micro-shader (oscillate/shake/swing/...)
 *   4. composite into the scene ping-pong buffer with transform, opacity and
 *      the layer's `blending` mode
 *
 * Everything it needs from renderer.js lives in the shared global scope of the
 * classic script (scene, tr, value, num, attr, clamp, color, fmt, mediaMap,
 * mediaSlots, canvas) — renderer.js loads first.
 *
 * On any hard failure it disables itself and the original 2D draw() takes over,
 * so a machine without WebGL still plays the scene.
 * ============================================================================= */
(function (global) {
  'use strict';

  var PAD_MIN = 16;          // px of bleed around layer content, for blur
  var PAD_RATIO = 0.15;      // ...and 15 % of the content half-size
  var MAX_EXT = 4096;        // never build a layer texture bigger than this
  var MAX_ERR = 3;           // structural failures before we give up on GL

  var engine = null;
  var ready = false, preparing = null, initErr = 0;
  var enabled = true;
  var broken = {}, errSeen = {};
  var images = null;
  var c2 = null, x2 = null;             // offscreen 2d canvas + ctx
  var glc = null;
  var layerCache = {};   // {w,h,st,tex} per indeks layer (raster tidak berubah antar frame)                        // offscreen WEBGL canvas (fix: #canvas sudah pegang context 2d)
  var progs = null;                     // {composite, builtin}
  var bgCache = null;

  var stats = {
    gl: false, layers: 0, fx: 0, native: 0, skipped: 0,
    missing: 0, broken: 0, ms: 0, ready: false
  };

  /* ------------------------------------------------------------------ blend */
  /* AM `blending` attribute -> mode id understood by the composite shader.
   * WebGL 1 has no separable colour-blending, so the exotic modes are folded
   * onto the closest separable formula. `mask` clips the backdrop by the
   * layer's alpha (AM's clipping behaviour). */
  var BLEND = {
    '': 0, 'normal': 0, 'src': 0, 'mask-fill': 0,
    'multiply': 1,
    'screen': 2,
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
    /* preset.html TIDAK punya `Gi` utk ini -> jatuh ke normal. Ikut. */
    'color': 0, 'saturation': 0, 'hue': 0, 'luminance': 0, 'luminosity': 0
  };

  /* ------------------------------------------------- native (shader-less) fx */
  /* The pack ships 46 effects with no <shader> — the APK draws those in Kotlin.
   * 474 of the 526 native effect instances found in others/*.xml fall into the
   * families below, all of which reduce to "move / rotate / fade the layer". */
  var NATIVE = {
    fade: 1, blink2: 2,
    oscillate: 3, oscillate2: 3, oscillate3: 3,
    shake: 4, shake2: 4,
    swing: 5, swing2: 5,
    randomdisplace: 6,
    spin: 7
  };

  /* --------------------------------------------------------------- helpers */
  function compile(gl, type, src, tag) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('compile ' + tag + ': ' + log);
    }
    return sh;
  }

  function makeProg(vs, fs, tag) {
    var gl = engine.gl;
    var v = compile(gl, gl.VERTEX_SHADER, vs, tag + '.vert');
    var f = compile(gl, gl.FRAGMENT_SHADER, fs, tag + '.frag');
    var p = gl.createProgram();
    gl.attachShader(p, v); gl.attachShader(p, f);
    gl.bindAttribLocation(p, 0, 'acPos');
    gl.bindAttribLocation(p, 1, 'acTexcoord');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error('link ' + tag + ': ' + gl.getProgramInfoLog(p));
    gl.deleteShader(v); gl.deleteShader(f);
    var u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) {
      var inf = gl.getActiveUniform(p, i);
      if (!inf) continue;
      var name = inf.name.replace(/\[0\]$/, '');
      u[name] = { loc: gl.getUniformLocation(p, inf.name), type: inf.type };
    }
    return { prog: p, u: u, tag: tag };
  }

  function bindQuad(P) {
    var gl = engine.gl;
    var a = gl.getAttribLocation(P.prog, 'acPos');
    var b = gl.getAttribLocation(P.prog, 'acTexcoord');
    if (a >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, engine.posBuf);
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, 4, gl.FLOAT, false, 0, 0);
    }
    if (b >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, engine.uvBuf);
      gl.enableVertexAttribArray(b);
      gl.vertexAttribPointer(b, 2, gl.FLOAT, false, 0, 0);
    }
  }

  function u1f(P, n, v) { var u = P.u[n]; if (u) engine.gl.uniform1f(u.loc, v); }
  function u1i(P, n, v) { var u = P.u[n]; if (u) engine.gl.uniform1i(u.loc, v); }
  function u2f(P, n, x, y) { var u = P.u[n]; if (u) engine.gl.uniform2f(u.loc, x, y); }

  function parseColor(v) {
    v = String(v || '#ff000000');
    if (/^#[0-9a-f]{8}$/i.test(v))
      return [parseInt(v.slice(2, 4), 16) / 255,
              parseInt(v.slice(4, 6), 16) / 255,
              parseInt(v.slice(6, 8), 16) / 255,
              parseInt(v.slice(0, 2), 16) / 255];
    if (/^#[0-9a-f]{6}$/i.test(v))
      return [parseInt(v.slice(1, 3), 16) / 255,
              parseInt(v.slice(3, 5), 16) / 255,
              parseInt(v.slice(5, 7), 16) / 255, 1];
    return [0, 0, 0, 1];
  }

  /* ---------------------------------------------------------------- shaders */
  var COMPACT_VS =
    'attribute vec4 acPos;attribute vec2 acTexcoord;varying vec2 vUv;' +
    'void main(){gl_Position=acPos;vUv=acTexcoord;}';

  /* Fullscreen pass: the quad covers the whole target and every pixel is
   * written — pixels outside the layer quad simply copy the backdrop, which is
   * what makes the ping-pong swap safe (no stale pixels left behind). */
  var COMPOSITE_FS = [
    'precision mediump float;',
    'varying vec2 vUv;',
    'uniform sampler2D uDst;',
    'uniform sampler2D uSrc;',
    'uniform vec2 uScene;',      // scene px
    'uniform vec2 uPos;',        // layer anchor, scene px, y-down
    'uniform vec2 uHalf;',       // layer texture half size, px
    'uniform vec2 uScale;',
    'uniform float uRot;',       // radians
    'uniform float uAlpha;',
    'uniform int uBlend;',
    'void main(){',
    '  vec3 dst=texture2D(uDst,vUv).rgb;',
    '  vec2 sp=vec2(vUv.x,1.0-vUv.y)*uScene;',           // scene px, y-down
    '  vec2 d=sp-uPos;',
    '  float c=cos(-uRot),s=sin(-uRot);',
    '  vec2 r=vec2(d.x*c-d.y*s,d.x*s+d.y*c);',           // undo rotation
    '  vec2 l=vec2(r.x/(abs(uScale.x)<1e-4?1e-4:uScale.x),',
    '              r.y/(abs(uScale.y)<1e-4?1e-4:uScale.y));',
    '  vec2 hn=l/uHalf;',
    '  if(abs(hn.x)>1.0||abs(hn.y)>1.0){gl_FragColor=vec4(dst,1.0);return;}',
    '  vec2 suv=vec2(hn.x*0.5+0.5,0.5-hn.y*0.5);',
    '  vec4 src=texture2D(uSrc,suv);',
    '  float a=clamp(src.a*uAlpha,0.0,1.0);',
    '  if(uBlend==13){gl_FragColor=vec4(dst*src.a,1.0);return;}',  /* mask = destination-in */
    '  if(uBlend==20){gl_FragColor=vec4(dst*(1.0-src.a),1.0);return;}', /* exclude = destination-out */
    '  vec3 top=src.rgb,bot=dst;',
    '  vec3 b;',
    '  if(uBlend==0){b=top;}',
    '  else if(uBlend==1){b=top*bot;}',
    '  else if(uBlend==2){b=1.0-(1.0-bot)*(1.0-top);}',
    '  else if(uBlend==3){b=min(bot+top,1.0);}',
    '  else if(uBlend==4){vec3 t=step(0.5,bot);b=t*(1.0-(1.0-2.0*(bot-0.5))*(1.0-top))+(1.0-t)*((2.0*bot)*top);}',
    '  else if(uBlend==5){b=min(bot,top);}',
    '  else if(uBlend==6){b=max(bot,top);}',
    '  else if(uBlend==7){b=max(bot-top,0.0);}',
    '  else if(uBlend==8){b=abs(bot-top);}',
    '  else if(uBlend==9){vec3 t=step(0.5,top);b=t*(1.0-(1.0-bot)*(1.0-(top-0.5)))+(1.0-t)*(bot*(top+0.5));}',
    '  else if(uBlend==10){vec3 t=step(0.5,top);b=t*(1.0-(1.0-bot)*(1.0-2.0*(top-0.5)))+(1.0-t)*(bot*(2.0*top));}',
    '  else if(uBlend==11){b=min(bot/max(1.0-top,1e-4),1.0);}',
    '  else if(uBlend==12){b=1.0-min((1.0-bot)/max(top,1e-4),1.0);}',
    '  else if(uBlend==14){vec3 t=step(0.5,bot);b=t*(1.0-(1.0-bot)*(1.0-(top-0.5)))+(1.0-t)*(bot*(top+0.5));}',
    '  else if(uBlend==15){vec3 t=step(0.5,top);b=t*max(bot,2.0*(top-0.5))+(1.0-t)*min(bot,2.0*top);}',
    '  else if(uBlend==16){vec3 t=step(0.5,top);b=t*(bot+2.0*(top-0.5))+(1.0-t)*(bot+2.0*top-1.0);}',
    '  else if(uBlend==17){vec3 t=step(0.5,top);b=t*(1.0-(1.0-bot)*(2.0*(top-0.5)))+(1.0-t)*(bot*(1.0-2.0*top));}',
    '  else if(uBlend==18){b=bot/max(top,1e-4);}',
    '  else if(uBlend==19){b=0.5-2.0*(bot-0.5)*(top-0.5);}',
    '  else if(uBlend==21){b=max(bot+top-1.0,0.0);}',
    '  else{b=top;}',
    '  gl_FragColor=vec4(mix(dst,b,a),1.0);',
    '}'
  ].join('\n');

  /* One micro-shader for every shader-less (native) effect: it can translate,
   * rotate and per-pixel scatter the layer, and scale its alpha. */
  var BUILTIN_FS = [
    'precision mediump float;',
    'varying vec2 vUv;',
    'uniform sampler2D uSrc;',
    'uniform vec2 uSize;',       // texture px
    'uniform vec2 uOffset;',     // layer px, y-down
    'uniform float uAlpha;',
    'uniform float uRot;',       // radians
    'uniform float uNoise;',     // px
    'uniform float uEvo;',
    'uniform float uSeed;',
    'float h21(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}',
    'void main(){',
    '  vec2 uv=vUv;',
    '  if(uRot!=0.0){vec2 c=uv-0.5;float s=sin(uRot),co=cos(uRot);',
    '    uv=vec2(c.x*co-c.y*s,c.x*s+c.y*co)+0.5;}',
    '  uv+=vec2(uOffset.x/max(uSize.x,1.0),-uOffset.y/max(uSize.y,1.0));',
    '  if(uNoise!=0.0){',
    '    vec2 cell=floor(uv*uSize/6.0)+vec2(uEvo,uSeed);',
    '    vec2 r=vec2(h21(cell),h21(cell+31.7))-0.5;',
    '    uv+=vec2(r.x*uNoise/max(uSize.x,1.0),r.y*uNoise/max(uSize.y,1.0));',
    '  }',
    '  vec4 col=texture2D(uSrc,uv);',
    '  gl_FragColor=vec4(col.rgb,col.a*uAlpha);',
    '}'
  ].join('\n');

  /* ------------------------------------------------------------ layer sizing */
  function extent(l, t) {
    var halfW, halfH;
    if (l.tagName === 'text') {
      var fs = num(attr(l, 'size', 48));
      var cn = l.querySelector('content');
      var lines = (cn ? cn.textContent : '').split('\n');
      x2.font = fs + 'px sans-serif';
      var mw = 0;
      for (var i = 0; i < lines.length; i++)
        mw = Math.max(mw, x2.measureText(lines[i]).width);
      var align = attr(l, 'align', 'left');
      var xmin, xmax;
      if (align === 'center') { xmin = -mw / 2; xmax = mw / 2; }
      else if (align === 'right') { xmin = -mw; xmax = 0; }
      else { xmin = 0; xmax = mw; }
      halfW = Math.max(Math.abs(xmin), Math.abs(xmax), 4);
      var ymin = -fs * 0.9;
      var ymax = (lines.length - 1) * fs * 1.2 + fs * 0.35;
      halfH = Math.max(Math.abs(ymin), Math.abs(ymax), 4);
    } else {
      var sz = amSize(l, t, '300,300');
      halfW = Math.max(Math.abs(sz[0] || 0) / 2, 4);
      halfH = Math.max(Math.abs(sz[1] || 0) / 2, 4);
    }
    var pad = Math.max(PAD_MIN, PAD_RATIO * Math.max(halfW, halfH));
    var w = Math.min(MAX_EXT, Math.max(4, Math.ceil((halfW + pad) * 2)));
    var h = Math.min(MAX_EXT, Math.max(4, Math.ceil((halfH + pad) * 2)));
    return { w: w, h: h };
  }

  /* Draw the layer content into c2, centred — no location/rotation/scale: the
   * composite pass applies those, exactly like renderer.js does with ctx. */

  function grad(ctx, g, size) {
    var st = vec(g.getAttribute('start') || '0,0'),
        en = vec(g.getAttribute('end') || '0,1');
    var P = function (v, k, sc) { return ((v.length > k ? v[k] : 0) * sc) - sc / 2; };
    var gr = ctx.createLinearGradient(P(st, 0, size[0]), P(st, 1, size[1]),
                                      P(en, 0, size[0]), P(en, 1, size[1]));
    gr.addColorStop(0, color(g.getAttribute('startColor') || '#ffffffff'));
    gr.addColorStop(1, color(g.getAttribute('endColor') || '#ff000000'));
    return gr;
  }

  function keyframedSize(l) {
    for (var i = 0; i < l.children.length; i++) {
      var c = l.children[i];
      if ((c.tagName === 'property' && c.getAttribute('name') === 'size') || c.tagName === 'size')
        if (c.querySelector('kf')) return true;
    }
    return false;
  }

  /* status isi media layer — dipakai sbg validitas cache raster */
  function imgState(l) {
    if (l.getAttribute('fillVideo')) return 'video';
    if (!l.getAttribute('fillImage')) return 'nofill';
    var sl = null;
    for (var i = 0; i < mediaSlots.length; i++)
      if (mediaSlots[i].layer === l) { sl = mediaSlots[i]; break; }
    if (!sl) return 'noslot';
    if (sl.missing) return 'missing';
    if (!sl.file) return 'pending';
    var m = mediaMap.get(sl.file.url);
    return m && m.ready ? 'ready' : 'loading';
  }

  function rasterize(l, t, w, h) {
    if (c2.width !== w) c2.width = w;
    if (c2.height !== h) c2.height = h;
    x2.setTransform(1, 0, 0, 1, 0, 0);
    x2.globalAlpha = 1;
    x2.clearRect(0, 0, w, h);
    x2.save();
    x2.translate(w / 2, h / 2);

    var size = amSize(l, t, '300,300');
    var slot = null;
    for (var i = 0; i < mediaSlots.length; i++)
      if (mediaSlots[i].layer === l) { slot = mediaSlots[i]; break; }
    var m = slot && slot.file ? mediaMap.get(slot.file.url) : null;
    var x0 = -size[0] / 2, y0 = -size[1] / 2;

    /* Layer coloring: fill-nya DIGAMBAR — bukan biar kelihatan, tapi jadi topeng
     * alpha. Efek pertamanya `lift` (name: "Copy Background") nuker isi layer sama
     * komposit bawah HANYA di piksel opaque. Tanpa alpha fill -> lift ngitung
     * comp*0 = transparan -> grading-nya ilang semua ("polos transparan"). */
    if (slot && slot.missing) {                 /* aset tak ikut kebundel: transparan */
      x2.restore(); return;
    }

    if (l.getAttribute('fillVideo') || l.getAttribute('fillImage')) {
      if (m && m.ready) {
        drawMedia(x2, m.element, l.getAttribute('mediaFillMode'), x0, y0, size[0], size[1]);
      } else if (slot) {
        x2.fillStyle = '#20263a';
        x2.fillRect(x0, y0, size[0], size[1]);
        x2.fillStyle = '#9aa4c0';
        x2.font = '16px sans-serif';
        x2.textAlign = 'center';
        x2.fillText('Pilih media', 0, 0);
      }
    } else if (l.tagName === 'text') {
      var fs = num(attr(l, 'size', 48));
      var cn = l.querySelector('content');
      x2.fillStyle = color(attr(l.querySelector('fillColor'), 'value', '#ffffffff'));
      x2.font = fs + 'px sans-serif';
      x2.textAlign = attr(l, 'align', 'left');
      var lines = (cn ? cn.textContent : '').split('\n');
      for (var j = 0; j < lines.length; j++) x2.fillText(lines[j], 0, j * fs * 1.2);
    } else {
      /* layer adjustment (CC I..IV): tanpa fillColor dan tanpa gradient
         -> JANGAN diisi putih, itu yang menutupi seluruh komposisi */
      var g = l.querySelector('gradient'), fc = l.querySelector('fillColor');
      if (g) { x2.fillStyle = grad(x2, g, size); x2.fillRect(x0, y0, size[0], size[1]); }
      else if (fc) { x2.fillStyle = color(fc.getAttribute('value') || '#ffffffff'); x2.fillRect(x0, y0, size[0], size[1]); }
      else if (isAdjustMask(l)) {
        /* fillColor ABSEN (mis. `ya ngentot`, fillType=color tapi tanpa <fillColor>)
         * -> alpha raster 0 -> `lift` ngitung comp*0 = KOSONG -> efeknya mati total.
         * Gambar mask opaque; warnanya gak ngaruh karena lift nuker isi layer
         * sama komposit bawah. Kalau lift gagal, guard di render() tetap buang. */
        x2.fillStyle = '#ffffffff'; x2.fillRect(x0, y0, size[0], size[1]);
      }
    }
    x2.restore();
  }

  function uploadLayer(w, h, name) {
    var gl = engine.gl;
    var t = engine._target(name || '__layer__', w, h);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c2);
    return t.tex;
  }

  function effectsOf(l) {
    var out = [];
    for (var i = 0; i < l.children.length; i++)
      if (l.children[i].tagName === 'effect') out.push(l.children[i]);
    return out;
  }

  /* <property name="x"> either holds <kf> keyframes or a constant `value`.
   * value() from renderer.js interpolates and returns a comma joined string. */
  function toVal(raw, param) {
    if (raw === undefined || raw === null) return param.default;
    if (param.kind === 'switch')
      return raw === true || raw === 'true' || raw === '1' || raw === 1;
    if (typeof param.default === 'boolean')
      return raw === true || raw === 'true' || raw === '1' || raw === 1;
    if (Array.isArray(param.default)) {
      if (raw.charAt && raw.charAt(0) === '#') {            // #AARRGGBB
        var h = raw.slice(1);
        if (h.length === 8)
          return [parseInt(h.slice(2, 4), 16) / 255,
                  parseInt(h.slice(4, 6), 16) / 255,
                  parseInt(h.slice(6, 8), 16) / 255,
                  parseInt(h.slice(0, 2), 16) / 255];
        if (h.length === 6)
          return [parseInt(h.slice(0, 2), 16) / 255,
                  parseInt(h.slice(2, 4), 16) / 255,
                  parseInt(h.slice(4, 6), 16) / 255, 1];
      }
      var parts = String(raw).split(',');
      var out = [];
      for (var i = 0; i < param.default.length; i++)
        out.push(Number(parts[i]));
      while (out.length < param.default.length) out.push(param.default[out.length]);
      return out;
    }
    var n = Number(raw);
    return Number.isFinite(n) ? n : param.default;
  }

  function valuesOf(el, meta, t) {
    var out = {};
    for (var i = 0; i < meta.params.length; i++) {
      var p = meta.params[i];
      if (p.kind === 'texture') continue;
      out[p.id] = toVal(value(el, p.id, t, p.default), p);
    }
    return out;
  }

  /* ------------------------------------------------------------ wave shapes */
  function wave(type, x) {
    var f = x - Math.floor(x);
    if (type === 1) return 1 - 4 * Math.abs(f - 0.5);   // triangle -1..1
    if (type === 2) return f < 0.5 ? 1 : -1;            // square
    return Math.sin(x * Math.PI * 2);                   // sine
  }
  function hash1(x) {
    var s = Math.sin(x * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  }
  function vnoise(x) {
    var i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    return hash1(i) + (hash1(i + 1) - hash1(i)) * u;
  }

  /** Native effect -> builtin shader uniforms. Returns null to pass through. */
  function nativeUniforms(file, v, timeSec, durSec) {
    var u = { ox: 0, oy: 0, alpha: 1, rot: 0, noise: 0, evo: 0, seed: 0 };
    switch (NATIVE[file]) {
      case 1: {                                   // fade: in/out ramp
        var tin = Math.abs(num(v.inTime, 0.5));
        var tout = Math.abs(num(v.outTime, 0.5));
        var el = timeSec, rem = Math.max(0, durSec - timeSec);
        var a = 1;
        if (tin > 1e-4) a = Math.min(a, Math.min(1, el / tin));
        if (tout > 1e-4) a = Math.min(a, Math.min(1, rem / tout));
        u.alpha = clamp(a, 0, 1);
        break;
      }
      case 2: {                                   // blink2: square on/off
        var fq = Math.abs(num(v.freq, 2));
        u.alpha = (Math.floor(timeSec * fq) % 2 === 0) ? 1 : 0;
        break;
      }
      case 3: {                                   // oscillate 1/2/3
        var ang = num(v.angle, 45) * Math.PI / 180;
        var fr = Math.abs(num(v.freq, 2));
        var mag = num(v.mag, 25);
        var ph = num(v.phase, 0);
        var w = wave(num(v.type, 0), fr * timeSec + ph);
        u.ox = Math.cos(ang) * mag * w;
        u.oy = -Math.sin(ang) * mag * w;
        break;
      }
      case 4: {                                   // shake / shake2
        var mg = num(v.mag, 50);
        var sp = num(v.speed, 0) || num(v.freq, 2);
        var evo = num(v.evolution, 0);
        var sd = num(v.seed, 0);
        var x = timeSec * sp * 3 + evo;
        u.ox = (vnoise(x + sd * 7.3) - 0.5) * 2 * mg;
        u.oy = (vnoise(x + sd * 7.3 + 19.7) - 0.5) * 2 * mg;
        break;
      }
      case 5: {                                   // swing / swing2
        var fq2 = Math.abs(num(v.freq, 2));
        var a1 = num(v.a1, -30), a2 = num(v.a2, 30);
        var ph2 = num(v.phase, 0);
        var w2 = wave(num(v.type, 0), fq2 * timeSec + ph2);
        u.rot = (a1 + (a2 - a1) * (w2 * 0.5 + 0.5)) * Math.PI / 180;
        break;
      }
      case 6: {                                   // randomdisplace
        u.noise = Math.abs(num(v.mag, 50));
        u.evo = num(v.evolution, 0);
        u.seed = num(v.seed, 0) * 13.7;
        break;
      }
      case 7: {                                   // spin: RPM -> rotasi konstan
        var rpm = num(v.rpm, 60);                 /* registry default 60 RPM */
        u.rot = (rpm * 6 * timeSec) * Math.PI / 180;  /* 60 RPM = 360°/dtk */
        break;
      }
      default: return null;
    }
    return u;
  }

  /* ----------------------------------------------------------- effect chain */
  function chainT(n, w, h) {
    return engine._target((n % 2) ? '__chainB__' : '__chainA__', w, h);
  }

  function runBuiltin(dst, input, w, h, u) {
    var gl = engine.gl, P = progs.builtin;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(P.prog);
    bindQuad(P);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, input);
    u1i(P, 'uSrc', 0);
    u2f(P, 'uSize', w, h);
    u2f(P, 'uOffset', u.ox, u.oy);
    u1f(P, 'uAlpha', u.alpha);
    u1f(P, 'uRot', u.rot);
    u1f(P, 'uNoise', u.noise);
    u1f(P, 'uEvo', u.evo);
    u1f(P, 'uSeed', u.seed);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /* Layer coloring yg punya efek ber-param `comp` (Copy Background) tapi gak
   * punya fillColor: perlu mask opaque supaya area-nya ke-cover. */
  function isAdjustMask(l) {
    if (typeof ccNoFill !== 'function' || !ccNoFill(l)) return false;
    var e = effectsOf(l);
    for (var i = 0; i < e.length; i++) {
      var m = engine.effect(attr(e[i], 'id'));
      if (!m || !m.params) continue;
      for (var j = 0; j < m.params.length; j++)
        if (m.params[j] && m.params[j].srcType === 'comp') return true;
    }
    return false;
  }

  /* --- jejak render layer coloring: biar #glState lapor apa yg beneran jalan --- */
  var ccTrace = [], ccShort = [], traceOn = false, ccLogKey = '';
  function trc(id, st, usesComp, vals) {
    if (!traceOn) return;
    var s = String(id).split('.').pop() + ':' + st + (usesComp ? '+comp' : '');
    if (vals) s += '(bm=' + vals.blendMode + ',a=' + vals.alpha + ',f=' + vals.fill + ')';
    ccTrace.push(s);
  }

  function applyEffect(el, input, ext, timeSec, durSec, tt, compTex, n) {
    var id = attr(el, 'id');
    var meta = engine.effect(id);
    if (!meta) { stats.missing++; trc(id, 'hilang', false, null); return {}; }
    if (broken[id]) { stats.broken++; trc(id, 'rusak', false, null); return {}; }

    var vals = valuesOf(el, meta, tt);
    /* Efek macam `lift` (Copy Background) nyedot tex komposit bawah lewat param
     * srcType="comp" — tanda layer ini berubah jadi adjustment layer. */
    var usesComp = false;
    for (var pi = 0; pi < meta.params.length; pi++) {
      if (meta.params[pi] && meta.params[pi].srcType === 'comp') { usesComp = true; break; }
    }
    var dst;
    try {
      if (meta.type !== 'shader') {
        stats.native++;
        var u = nativeUniforms(meta.file, vals, timeSec, durSec);
        if (!u) { stats.skipped++; trc(id, 'native-skip', false, vals); return {}; }
        dst = chainT(n, ext.w, ext.h);
        runBuiltin(dst, input, ext.w, ext.h, u);
        trc(id, 'native', usesComp, vals);
        return { tex: dst.tex, n: n + 1, usesComp: usesComp };
      }
      dst = chainT(n, ext.w, ext.h);
      var res = engine.renderSync(meta, {
        input: input, dst: dst, width: ext.w, height: ext.h,
        time: timeSec, comp: compTex, images: images, values: vals,
        globals: {
          acTime: timeSec,
          acLayerSize: [ext.w, ext.h],
          acLayerCenter: [ext.w / 2, ext.h / 2],
          acLayerCenterNorm: [0.5, 0.5],
          acLayerSizeNorm: [ext.w / scene.w, ext.h / scene.h],
          acProjectSize: [scene.w, scene.h],
          acPreviewSize: [engine.canvas.width || scene.w, engine.canvas.height || scene.h]
        }
      });
      stats.fx++;
      trc(id, 'ok', usesComp, vals);
      return { tex: res.texture, n: n + 1, usesComp: usesComp };
    } catch (e) {
      if (!errSeen[id]) { errSeen[id] = 1; console.warn('[glscene] effect gagal:', id, e); }
      broken[id] = true;
      stats.skipped++;
      trc(id, 'ERROR', false, vals);
      return {};
    }
  }

  /* -------------------------------------------------------------- composite */
  function composite(write, read, srcTex, ext, q, alpha, blend) {
    var gl = engine.gl, P = progs.composite;
    gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo);
    gl.viewport(0, 0, write.w, write.h);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.useProgram(P.prog);
    bindQuad(P);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, read.tex);
    u1i(P, 'uDst', 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    u1i(P, 'uSrc', 1);
    u2f(P, 'uScene', scene.w, scene.h);
    u2f(P, 'uPos', q.pos[0], q.pos[1]);
    u2f(P, 'uHalf', ext.w / 2, ext.h / 2);
    u2f(P, 'uScale', q.scale[0], q.scale[1]);
    u1f(P, 'uRot', q.rot * Math.PI / 180);
    u1f(P, 'uAlpha', clamp(q.opacity, 0, 1) * alpha);
    u1i(P, 'uBlend', blend);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.activeTexture(gl.TEXTURE0);
  }

  /* ------------------------------------------------------------- main render */
  function render(timeMs) {
    if (!ready || !scene || !engine) return false;
    var t0 = (global.performance && performance.now()) || Date.now();
    var W = scene.w, H = scene.h;
    var bg = bgCache && bgCache.key === attr(scene.root, 'bgcolor', '#ff000000')
      ? bgCache.rgba : parseColor(attr(scene.root, 'bgcolor', '#ff000000'));
    bgCache = { key: attr(scene.root, 'bgcolor', '#ff000000'), rgba: bg };

    var gl = engine.gl;
    var A = engine._target('__sceneA__', W, H);
    var B = engine._target('__sceneB__', W, H);

    gl.bindFramebuffer(gl.FRAMEBUFFER, A.fbo);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    gl.clearColor(bg[0], bg[1], bg[2], bg[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);

    var read = A, write = B;
    stats.layers = 0; stats.fx = 0; stats.native = 0;
    stats.skipped = 0; stats.missing = 0; stats.broken = 0;
    ccTrace = []; ccShort = []; stats.cc = '';

    for (var i = 0; i < scene.layers.length; i++) {
      var l = scene.layers[i];
      if (l && l.getAttribute && l.getAttribute('hidden') === 'true') continue;
      var a = num(attr(l, 'startTime', 0)), b = num(attr(l, 'endTime', scene.duration));
      if (timeMs < a || timeMs > b) continue;
      var tt = clamp((timeMs - a) / (b - a || 1), 0, 1);
      var q = tr(l, tt);
      var opac = clamp(q.opacity, 0, 1);
      if (opac <= 0) continue;
      stats.layers++;

      var ext = extent(l, tt);
      var st = imgState(l);
      var noCache = l.getAttribute('fillVideo') || keyframedSize(l);
      var tex;
      if (noCache) {
        rasterize(l, tt, ext.w, ext.h);
        tex = uploadLayer(ext.w, ext.h);
      } else {
        var hit = layerCache[i];
        if (hit && hit.w === ext.w && hit.h === ext.h && hit.st === st) {
          tex = hit.tex;                       /* raster tidak berubah: lewati upload */
        } else {
          rasterize(l, tt, ext.w, ext.h);
          tex = uploadLayer(ext.w, ext.h, '__lc' + i);
          layerCache[i] = { w: ext.w, h: ext.h, st: st, tex: tex };
        }
      }

      var effs = effectsOf(l);
      var timeSec = (timeMs - a) / 1000;
      var durSec = (b - a) / 1000;
      var cur = tex, n = 0, alpha = 1, usedComp = false;
      var isCC = (typeof ccNoFill === 'function') && ccNoFill(l);
      traceOn = isCC;
      for (var k = 0; k < effs.length; k++) {
        var r = applyEffect(effs[k], cur, ext, timeSec, durSec, tt, read.tex, n);
        if (r.tex) { cur = r.tex; n = r.n; if (r.usesComp) usedComp = true; }
      }

      var blendId = BLEND[String(attr(l, 'blending', '')).toLowerCase()] || 0;
      traceOn = false;
      var guard = isCC && !usedComp && blendId === 0;
      if (isCC) {
        var lbl = attr(l, 'label', '') || l.tagName;
        ccTrace.push('#' + i + ' ' + lbl + '  n=' + n + '/' + effs.length +
          ' comp=' + (usedComp ? 1 : 0) + ' blend=' + blendId + (guard ? ' GUARD!' : ''));
        ccShort.push(i + ':' + n + '/' + effs.length + 'c' + (usedComp ? 1 : 0) + (guard ? '!' : ''));
      }
      /* Guard anti-balok: layer coloring TANPA "Copy Background" yang berhasil
       * (lift rusak/belum ke-load) -> fill mentahnya bakal nongol jadi kotak
       * solid. Buang kalo blend normal; blend campur (lighten/screen/...) aman
       * karena gak menutup backdrop (lighten hitam = backdrop). */
      if (guard) { stats.skipped++; continue; }

      composite(write, read, cur, ext, q, alpha, blendId);
      var tmp = read; read = write; write = tmp;
    }

    stats.cc = ccShort.join(' ');
    /* log sekali per perubahan — jangan spam tiap frame */
    var ck = stats.cc + '|' + ccTrace.join('|');
    if (ccTrace.length && ck !== ccLogKey) { ccLogKey = ck; console.log('[cc]', stats.cc, ccTrace.join(' | ')); }
    engine.blit(read.tex, null, W, H);
    stats.ms = ((global.performance && performance.now()) || Date.now()) - t0;
    return true;
  }

  /* ------------------------------------------------------------ boot / prep */
  function ensureCanvas() {
    if (!c2) { c2 = document.createElement('canvas'); x2 = c2.getContext('2d'); }
  }

  function loadImages() {
    var jobs = [], out = {};
    if (!engine.fx) return Promise.resolve(out);
    var seen = {};
    engine.fx.effects.forEach(function (e) {
      (e.params || []).forEach(function (p) {
        if (p.srcType !== 'image' || !p.src || seen[p.id]) return;
        seen[p.id] = 1;
        jobs.push(
          fetch('/webfx/' + p.src).then(function (r) {
            if (!r.ok) throw new Error(p.src + ' ' + r.status);
            return r.blob();
          }).then(function (b) {
            if (global.createImageBitmap) return createImageBitmap(b);
            return new Promise(function (res, rej) {
              var im = new Image();
              im.onload = function () { res(im); };
              im.onerror = function () { rej(new Error('gagal decode ' + p.src)); };
              im.src = URL.createObjectURL(b);
            });
          }).then(function (img) {
            out[p.id] = engine.textureFromCanvas(img, true);
          }).catch(function (e) {
            console.warn('[glscene] gambar effect gagal:', p.src, e);
          })
        );
      });
    });
    return Promise.all(jobs).then(function () { return out; });
  }

  function preloadScene() {
    var ids = {}, jobs = [];
    if (!scene) return Promise.resolve();
    scene.layers.forEach(function (l) {
      effectsOf(l).forEach(function (el) {
        var id = attr(el, 'id');
        if (ids[id]) return;
        ids[id] = 1;
        var meta = engine.effect(id);
        if (!meta) { stats.missing++; return; }
        jobs.push(engine.preload(id).catch(function (e) {
          broken[id] = e && e.message ? e.message : String(e);
          console.warn('[glscene] preload gagal:', id, e);
        }));
      });
    });
    return Promise.all(jobs);
  }

  /* #canvas sudah punya context 2d (renderer.js), sehingga getContext('webgl')
   * di situ SELALU null. GL jadi canvas offscreen sendiri, hasilnya di-blit. */
  function glCanvas() {
    if (!glc) glc = document.createElement('canvas');
    var w = (scene && scene.w) || (canvas && canvas.width) || 1080;
    var h = (scene && scene.h) || (canvas && canvas.height) || 1920;
    if (glc.width !== w) glc.width = w;
    if (glc.height !== h) glc.height = h;
    return glc;
  }

  function blitGL() {
    if (!glc) return;
    var cw = canvas.width, ch = canvas.height;
    if (!cw || !ch) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(glc, 0, 0, cw, ch);
    ctx.restore();
  }

  function prepare() {
    if (preparing) return preparing;
    if (!global.AMFX) return Promise.reject(new Error('glx.js belum termuat'));
    try {
      ensureCanvas();
      if (!engine) engine = new AMFX.Engine(glCanvas());
      stats.gl = !!engine.gl;
    } catch (e) {                      // no WebGL / context refused
      initErr++;
      stats.gl = false;
      if (initErr >= MAX_ERR) enabled = false;
      console.warn('[glscene] WebGL tidak bisa dibuka:', e);
      return Promise.reject(e);
    }
    preparing = engine.load('/webfx/effects.json')
      .then(function () { return loadImages(); })
      .then(function (im) {
        images = im;
        progs = {
          composite: makeProg(COMPACT_VS, COMPOSITE_FS, 'composite'),
          builtin: makeProg(COMPACT_VS, BUILTIN_FS, 'builtin')
        };
        return preloadScene();
      })
      .then(function () {
        ready = true; stats.ready = true; preparing = null;
        console.log('[glscene] siap —', Object.keys(broken).length,
          'effect rusak,', stats.missing, 'effect tak dikenal');
        if (scene) draw(typeof offset === 'number' ? offset : 0);
      })
      .catch(function (e) {
        preparing = null;
        initErr++;
        stats.ready = false;
        console.warn('[glscene] gagal:', e);
        if (initErr >= MAX_ERR) { enabled = false; stats.gl = false; }
        return Promise.reject(e);
      });
    return preparing;
  }

  function onScene() {
    ready = false; preparing = null;
    broken = {}; errSeen = {}; bgCache = null;
    layerCache = {};
    initErr = 0;
    if (scene) prepare().catch(function () {});
  }

  /* ----------------------------------------------------------------- patch */
  var origDraw = global.draw;
  var origParse = global.parse;

  if (typeof origDraw === 'function') {
    global.draw = function (t) {
      if (enabled && ready && scene) {
        try {
          if (render(t)) { blitGL(); syncTime(t);
            if (typeof DBG !== 'undefined' && DBG && typeof drawDebug === 'function') drawDebug(t);
            return; }
        } catch (e) {
          console.warn('[glscene] render error:', e);
          initErr++;
          if (initErr >= MAX_ERR) { enabled = false; console.warn('[glscene] fallback ke renderer 2D'); }
        }
      }
      return origDraw(t);
    };
  }

  if (typeof origParse === 'function') {
    global.parse = function (text) {
      var r = origParse(text);
      onScene();
      return r;
    };
  }

  function syncTime(t) {
    var tl = $('timeline');
    if (tl) tl.value = t;
    var lab = $('timeLabel');
    if (lab && scene) lab.textContent = fmt(t) + ' / ' + fmt(scene.duration);
  }

  global.GLScene = {
    render: render,
    prepare: prepare,
    onScene: onScene,
    stats: stats,
    setEnabled: function (v) { enabled = !!v; },
    isEnabled: function () { return enabled; },
    isReady: function () { return ready; },
    engine: function () { return engine; },
    broken: function () { return broken; }
  };
})(window);
