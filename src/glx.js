/* =============================================================================
 * glx.js — Alight Motion effect pipeline for the web (WebGL 1 / ESSL 1.00)
 *
 * Consumes webfx/effects.json (built by tools/build_effects.py) + the
 * preprocessed GLSL under webfx/glsl/.
 *
 * Contract we implement (reverse engineered from the APK):
 *   varying vec2 acScreenNorm          uv, y-up (GL convention)
 *   uniform  vec2 acScreenSize         render target px
 *   uniform  vec2 acLayerSize          layer px
 *   uniform  vec2 acLayerCenter        layer center px
 *   uniform  vec2 acLayerCenterNorm    layer center, normalized
 *   uniform  vec2 acLayerPivot         pivot offset px
 *   uniform  vec2 acLayerSizeNorm      layer/screen ratio
 *   uniform  vec2 acPreviewSize        preview canvas px
 *   uniform  vec2 acProjectSize        project px
 *   uniform  vec2 acVelocity           per frame translation
 *   uniform  float acTime              seconds
 *   uniform  float acAngularVelocity / acScaleVelocity
 *   uniform  mat3  acScreenToLayer / acLayerToScreen
 *   uniform  mat4  acLTS
 *   uniform  bool  acShowGuides
 *   uniform  int   acPass              index in <passes>
 *   vec4 texture2DCv(sampler2D, vec2)  -> texture2D
 *   vec2 getTexSize(vec2)              -> identity (texture .size)
 *   saturate() x4 overloads
 *
 * Texture params are bound as sampler2D + a companion vec2 `__sz_<id>`.
 * ============================================================================= */
(function (global) {
  'use strict';

  var IDENT3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  var IDENT4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  function compile(gl, type, src, tag) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      var lines = src.split('\n');
      var ctx = [];
      (log || '').split('\n').forEach(function (l) {
        var m = l.match(/ERROR:\s*\d+:(\d+)/);
        if (m) {
          var n = +m[1];
          for (var i = Math.max(0, n - 3); i < Math.min(lines.length, n + 2); i++)
            ctx.push((i + 1 === n ? '> ' : '  ') + (i + 1) + ': ' + lines[i]);
        }
      });
      var err = new Error('shader compile failed [' + tag + ']\n' + log +
        (ctx.length ? '\n' + ctx.join('\n') : ''));
      err.shaderLog = log; err.shaderTag = tag;
      throw err;
    }
    return sh;
  }

  function link(gl, vs, fs, tag) {
    var p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    // stable attribute slots so the quad VBO works for every program
    gl.bindAttribLocation(p, 0, 'acPos');
    gl.bindAttribLocation(p, 1, 'acTexcoord');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error('link failed [' + tag + ']\n' + gl.getProgramInfoLog(p));
    return p;
  }

  /* ------------------------------------------------------------------ Engine */
  function Engine(canvas) {
    var opts = {
      alpha: true, premultipliedAlpha: false, antialias: false,
      depth: false, stencil: false, preserveDrawingBuffer: true,
      powerPreference: 'high-performance'
    };
    this.canvas = canvas || document.createElement('canvas');
    this.gl = this.canvas.getContext('webgl', opts) ||
              this.canvas.getContext('experimental-webgl', opts);
    if (!this.gl) throw new Error('WebGL 1 tidak tersedia di browser ini');

    var gl = this.gl;
    this.highp = true;
    try {
      this.highp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT).precision > 0;
    } catch (e) { this.highp = true; }
    this.precision = this.highp ? 'highp' : 'mediump';

    this.base = {
      // fullscreen quad:  acPos = clip xy (+ z,w),  acTexcoord = uv (y-up)
      pos: new Float32Array([-1, -1, 0, 1, 1, -1, 0, 1, -1, 1, 0, 1, 1, 1, 0, 1]),
      uv:  new Float32Array([0, 0, 1, 0, 0, 1, 1, 1])
    };
    this.posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.base.pos, gl.STATIC_DRAW);
    this.uvBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.base.uv, gl.STATIC_DRAW);

    this.programs = new Map();     // srcUrl -> {prog, uniforms}
    this.targets  = new Map();     // name -> {tex, fbo, w, h}
    this.textures = new Map();     // url -> texture (assets)
    this.fx       = null;          // effects.json
    this.byId     = new Map();
    this.glslSrc  = new Map();
    this.warnings = [];
    this.lastError = null;

    this._blit = null;
    this._quadDirty = true;
  }

  /* --------------------------------------------------------------- load meta */
  Engine.prototype.load = function (jsonUrl) {
    var self = this;
    jsonUrl = jsonUrl || '/webfx/effects.json';
    return fetch(jsonUrl).then(function (r) {
      if (!r.ok) throw new Error('gagal memuat ' + jsonUrl + ' (' + r.status + ')');
      return r.json();
    }).then(function (j) {
      self.fx = j;
      self.byId = new Map();
      (j.effects || []).forEach(function (e) {
        self.byId.set(e.id, e);
        self.byId.set(e.file, e);
      });
      return j;
    });
  };

  Engine.prototype.effect = function (key) {
    if (!this.fx) throw new Error('effects.json belum di-load');
    return this.byId.get(key) || null;
  };

  Engine.prototype.listByCategory = function () {
    var out = {};
    if (!this.fx) return out;
    this.fx.effects.forEach(function (e) {
      (out[e.category] = out[e.category] || []).push(e);
    });
    return out;
  };

  /* ------------------------------------------------- shim ESSL 1.0 (loop)
   * Kita minta konteks WebGL1 ('webgl'), jadi semua shader dikompilasi sebagai
   * GLSL ES 1.00 — di situ "for" WAJIB berbentuk for (int i = <konstan>;
   * i < <ekspresi konstan>; ...). Shader asli AM sering memakai batas yang
   * berasal dari PARAMETER FUNGSI, contoh nyata di paket ini:
   *     clouds.0.fragment   : float fbm(vec2 st, ..., int octaveCount, ...)
   *                            for (int i = 0; i < octaveCount; i++)
   *     ridges.0.fragment   : float ridgedMF(vec2 p, in int OCTAVES, ...)
   *     dots2.0.fragment    : for (int k = 0; k < densitySteps; k++)
   * 40 file / 46 loop begitu -> driver ketat (Mali/Adreno/ANGLE) menolak
   * kompilasi dan efeknya lenyap diam-diam (tercatat di stats.broken).
   *
   * Solusi yang sama persis dipakai motionary (github.com/ryuhandev/motionary,
   * amgl.js patchShaderSource): batas loop diganti angka aman lalu kondisi
   * aslinya dipindah ke `break` di dalam badan loop — semantik identik selama
   * 9999 >= batas asli (semua jumlah iterasi efek AM jauh di bawah itu). */
  var LOOP_BOUND_MAX = 9999;
  function patchShaderSource(src, path) {
    var n = 0;
    var out = src.replace(
      /for\s*\(\s*int\s+(\w+)\s*=\s*(-?\d+)\s*;\s*\1\s*(<=|<)\s*([^;]+?)\s*;\s*\1\s*(?:\+\+|\+=\s*1)\s*\)\s*\{/g,
      function (m, iv, init, op, bound) {
        if (/^\s*\d+\s*$/.test(bound)) return m;      /* sudah konstan -> biarkan */
        n++;
        var test = op === '<=' ? '>' : '>=';
        return 'for (int ' + iv + ' = ' + init + '; ' + iv + ' < ' + LOOP_BOUND_MAX +
               '; ' + iv + '++) { if (' + iv + ' ' + test + ' (' + bound + ')) break;';
      });
    if (n) console.log('[glx] shim loop ESSL1: ' + n + ' loop di ' + (path || '?'));
    return out;
  }

  /* ------------------------------------------------------------ glsl loading */
  Engine.prototype.getGlsl = function (path) {
    var self = this;
    if (this.glslSrc.has(path)) return Promise.resolve(this.glslSrc.get(path));
    return fetch('/webfx/' + path).then(function (r) {
      if (!r.ok) throw new Error('gagal memuat ' + path + ' (' + r.status + ')');
      return r.text();
    }).then(function (t) {
      if (self.precision !== 'highp')
        t = t.replace(/precision highp float;/, 'precision mediump float;')
             .replace(/precision highp int;/, 'precision mediump int;');
      t = patchShaderSource(t, path);     /* WAJIB sebelum compile: ESSL 1.0 */
      self.glslSrc.set(path, t);
      return t;
    });
  };

  /* ------------------------------------------------------------- program cache */
  Engine.prototype._program = function (vertPath, fragPath) {
    var self = this, gl = this.gl, key = vertPath + '|' + fragPath;
    if (this.programs.has(key)) return this.programs.get(key);
    return Promise.all([this.getGlsl(vertPath), this.getGlsl(fragPath)])
      .then(function (src) {
        var vs = compile(gl, gl.VERTEX_SHADER, src[0], vertPath);
        var fs = compile(gl, gl.FRAGMENT_SHADER, src[1], fragPath);
        var prog = link(gl, vs, fs, key);
        gl.deleteShader(vs); gl.deleteShader(fs);
        var uni = {};
        var n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
        for (var i = 0; i < n; i++) {
          var info = gl.getActiveUniform(prog, i);
          if (!info) continue;
          var name = info.name.replace(/\[0\]$/, '');
          uni[name] = { loc: gl.getUniformLocation(prog, info.name), type: info.type, size: info.size };
        }
        var entry = { prog: prog, uniforms: uni, key: key };
        self.programs.set(key, entry);
        return entry;
      });
  };

  /* ------------------------------------------------------------ render targets */
  Engine.prototype._target = function (name, w, h) {
    var gl = this.gl, t = this.targets.get(name);
    if (t && t.w === w && t.h === h) return t;
    if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error('FBO tidak lengkap: ' + name);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    t = { tex: tex, fbo: fbo, w: w, h: h, name: name };
    tex._w = w; tex._h = h;
    this.targets.set(name, t);
    if (!this._texOwner) this._texOwner = new Map();
    this._texOwner.set(tex, t);
    return t;
  };

  Engine.prototype._scratch = function (w, h) { return this._target('__scratch__', w, h); };

  Engine.prototype.textureFromCanvas = function (canvasOrImage, flipY) {
    var gl = this.gl, tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY !== false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvasOrImage);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    tex._w = canvasOrImage.width; tex._h = canvasOrImage.height;
    return tex;
  };

  Engine.prototype.textureFromPixels = function (w, h, data) {
    var gl = this.gl, tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    tex._w = w; tex._h = h;
    return tex;
  };

  /** WebGLTexture carries no size — we tag ours and fall back to defaults. */
  Engine.prototype.dimsOf = function (tex, fw, fh) {
    if (tex && tex._w) return { w: tex._w, h: tex._h };
    var t = tex && this._texOwner && this._texOwner.get(tex);
    if (t) return { w: t.w, h: t.h };
    return { w: fw || 1024, h: fh || 1024 };
  };

  /* -------------------------------------------------------------- draw plumbing */
  Engine.prototype._bindQuad = function (prog) {
    var gl = this.gl;
    var a = gl.getAttribLocation(prog, 'acPos');
    var b = gl.getAttribLocation(prog, 'acTexcoord');
    if (a >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, 4, gl.FLOAT, false, 0, 0);
    }
    if (b >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
      gl.enableVertexAttribArray(b);
      gl.vertexAttribPointer(b, 2, gl.FLOAT, false, 0, 0);
    }
  };

  Engine.prototype._setUniform = function (u, value, texUnit) {
    var gl = this.gl;
    switch (u.type) {
      case gl.FLOAT:        gl.uniform1f(u.loc, +value || 0); break;
      case gl.FLOAT_VEC2:   gl.uniform2f(u.loc, value[0] || 0, value[1] || 0); break;
      case gl.FLOAT_VEC3:   gl.uniform3f(u.loc, value[0] || 0, value[1] || 0, value[2] || 0); break;
      case gl.FLOAT_VEC4:   gl.uniform4f(u.loc, value[0] || 0, value[1] || 0, value[2] || 0, value[3] || 0); break;
      case gl.INT:
      case gl.BOOL:         gl.uniform1i(u.loc, typeof value === 'boolean' ? (value ? 1 : 0) : (+value | 0)); break;
      case gl.INT_VEC2:
      case gl.BOOL_VEC2:    gl.uniform2i(u.loc, value[0] | 0, value[1] | 0); break;
      case gl.SAMPLER_2D:   gl.uniform1i(u.loc, texUnit); break;
      case gl.FLOAT_MAT3:   gl.uniformMatrix3fv(u.loc, false, value); break;
      case gl.FLOAT_MAT4:   gl.uniformMatrix4fv(u.loc, false, value); break;
      default:              break;
    }
  };

  /* ------------------------------------------------------------------ defaults */
  function globals(w, h, pass, time) {
    return {
      acScreenSize: [w, h],
      acLayerSize: [w, h],
      acLayerCenter: [w / 2, h / 2],
      acLayerCenterNorm: [0.5, 0.5],
      acLayerPivot: [0, 0],
      acLayerSizeNorm: [1, 1],
      acPreviewSize: [w, h],
      acProjectSize: [w, h],
      acVelocity: [0, 0],
      acTime: time || 0,
      acAngularVelocity: 0,
      acScaleVelocity: 0,
      acScreenToLayer: IDENT3,
      acLayerToScreen: IDENT3,
      acLTS: IDENT4,
      acShowGuides: false,
      acPass: pass || 0
    };
  }

  /** globals() + per-call overrides (layer size, project size, ...). */
  Engine.prototype._globals = function (w, h, pass, time, over) {
    var g = globals(w, h, pass, time);
    if (over) for (var k in over) if (over[k] !== undefined) g[k] = over[k];
    return g;
  };

  /* ------------------------------------------------------------------ execute */
  /**
   * Resolve everything that does not touch GL state.
   * Throws synchronously — render() converts it into a rejection.
   *
   *   opts = {
   *     input : WebGLTexture        layer content (required)
   *     comp  : WebGLTexture|null   composition/background
   *     images: {id: WebGLTexture}  srcType="image" assets
   *     values: {paramId: value}    user param values (defaults applied)
   *     width , height              render target size
   *     time                        seconds (acTime)
   *     group                       shader group index (default 0)
   *     globals                     per-call overrides for the ac* uniforms
   *     dst                         optional target to write into
   *   }
   */
  Engine.prototype._prepare = function (key, opts) {
    var self = this;
    var meta = typeof key === 'string' ? this.effect(key) : key;
    if (!meta) throw new Error('effect tidak ditemukan: ' + key);

    var content = opts.input;
    if (!content) throw new Error('opts.input wajib diisi');

    var d = this.dimsOf(content, opts.width, opts.height);
    var W = opts.width  || d.w;
    var H = opts.height || d.h;

    var values = Object.assign({}, opts.values || {});
    meta.params.forEach(function (p) {
      if (p.kind === 'texture') return;
      if (values[p.id] === undefined) values[p.id] = p.default;
    });

    var passes = (meta.passes && meta.passes.length) ? meta.passes : [{}];
    var iters = 1;
    if (meta.iterations) {
      var iv = +values[meta.iterations];
      iters = Math.max(1, Math.round(Number.isFinite(iv) ? iv : 1));
      if (iters > 32) iters = 32;
    }

    var group = (opts.group !== undefined && opts.group !== null) ? opts.group : 0;

    // ---- resolve one program per pass (a pass may delegate to another effect)
    var steps = passes.map(function (p, i) {
      var eff = (p.effect && self.effect(p.effect)) ? self.effect(p.effect) : meta;
      var sub = eff !== meta;
      // values: our own first, then the sub-effect's defaults for anything missing
      var vals = values;
      if (sub) {
        vals = Object.assign({}, values);
        eff.params.forEach(function (q) {
          if (q.kind === 'texture') return;
          if (vals[q.id] === undefined) vals[q.id] = q.default;
        });
      }
      var frag = pickGroup(eff.shaders, 'fragment', group);
      var vert = pickGroup(eff.shaders, 'vertex', group);
      return {
        pass: p, idx: i, eff: eff, sub: sub, values: vals,
        fragPath: frag ? frag.src : null,
        vertPath: vert ? vert.src : 'glsl/__default.vert',
        paramMap: paramMapOf(eff)
      };
    });

    if (steps.some(function (s) { return !s.fragPath; }))
      throw new Error('effect ' + meta.file + ' tidak punya fragment shader untuk group ' + group);

    return {
      meta: meta, values: values, steps: steps,
      W: W, H: H, iters: iters, content: content
    };
  };

  /** Compile every (vert, frag) pair the effect can ask for, all shader groups. */
  Engine.prototype.preload = function (key, group) {
    var self = this;
    var meta = typeof key === 'string' ? this.effect(key) : key;
    if (!meta) return Promise.resolve(false);
    var groups = {};
    (meta.shaders || []).forEach(function (s) {
      if (s.type === 'fragment') groups[s.group || 0] = 1;
    });
    if (!Object.keys(groups).length) groups[0] = 1;
    var jobs = [];
    Object.keys(groups).forEach(function (g) {
      var gi = (group !== undefined && group !== null) ? group : +g;
      var frag = pickGroup(meta.shaders, 'fragment', gi);
      var vert = pickGroup(meta.shaders, 'vertex', gi);
      if (frag) jobs.push(self._program(vert ? vert.src : 'glsl/__default.vert', frag.src));
      (meta.passes || []).forEach(function (p) {
        if (p.effect && self.effect(p.effect)) jobs.push(self.preload(p.effect, gi));
      });
    });
    return Promise.all(jobs).then(function () { return true; }, function (e) {
      self.warnings.push('preload gagal ' + meta.file + ': ' + (e && e.message));
      throw e;
    });
  };

  Engine.prototype._execute = function (P, opts) {
    var self = this;
    var meta = P.meta, steps = P.steps, W = P.W, H = P.H, iters = P.iters;
    var content = P.content;

    var dst = opts.dst || self._target('__dst_' + meta.file + '_' + W + 'x' + H, W, H);
    var warnings = [];
    var readTex = content, finalTex = dst.tex;

    for (var it = 0; it < iters; it++) {
      for (var pi = 0; pi < steps.length; pi++) {
        var s = steps[pi], pass = s.pass;
        var out = pass.target ? self._target(pass.target, W, H) : dst;
        var passContent = (pass.src && self.targets.get(pass.src))
          ? self.targets.get(pass.src).tex : content;

        self._draw(s.prog, {
          paramMap: s.paramMap, values: s.values, warnings: warnings,
          globals: self._globals(W, H, pi, opts.time || 0, opts.globals),
          content: passContent, comp: opts.comp || content,
          images: opts.images || {}, buffers: self.targets,
          width: W, height: H, target: out
        });

        if (!pass.target) finalTex = out.tex;
        readTex = out.tex;
      }
      content = readTex;
    }

    return {
      texture: finalTex, width: W, height: H,
      warnings: warnings, passes: steps.length, iterations: iters
    };
  };

  /**
   * Run one effect (async — compiles the shaders on first use).
   * Returns Promise<{texture, width, height, warnings, passes}>.
   */
  Engine.prototype.render = function (key, opts) {
    var self = this, P;
    try { P = this._prepare(key, opts); }
    catch (e) { return Promise.reject(e); }
    return Promise.all(P.steps.map(function (s) { return self._program(s.vertPath, s.fragPath); }))
      .then(function (progs) {
        P.steps.forEach(function (s, i) { s.prog = progs[i]; });
        return self._execute(P, opts);
      }).catch(function (e) { self.lastError = e; throw e; });
  };

  /**
   * Synchronous variant for the per-frame path: every program must already be
   * in the cache (see preload()). Throws if it is not.
   */
  Engine.prototype.renderSync = function (key, opts) {
    var self = this, P = this._prepare(key, opts);
    P.steps.forEach(function (s) {
      var e = self.programs.get(s.vertPath + '|' + s.fragPath);
      if (!e) throw new Error('program belum di-preload: ' + s.fragPath);
      s.prog = e;
    });
    try { return this._execute(P, opts); }
    catch (e) { this.lastError = e; throw e; }
  };

  function pickGroup(shaders, type, group) {
    if (!shaders) return null;
    var hit = null, any = null;
    shaders.forEach(function (s) {
      if (s.type !== type) return;
      if (s.group === group) hit = s;
      if (!any) any = s;
    });
    return hit || any;
  }

  function paramMapOf(eff) {
    var m = {};
    (eff.params || []).forEach(function (p) { m[p.id] = p; });
    return m;
  }

  /* --------------------------------------------------------------- single draw */
  Engine.prototype._draw = function (P, S) {
    var gl = this.gl, meta = S.meta;

    gl.bindFramebuffer(gl.FRAMEBUFFER, S.target ? S.target.fbo : null);
    gl.viewport(0, 0, S.width, S.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(P.prog);
    this._bindQuad(P.prog);

    var unit = 0;
    var bound = {};                       // name -> texture
    var sizes = {};                       // __sz_id -> [w,h]

    // resolve every sampler the program actually uses
    Object.keys(P.uniforms).forEach(function (name) {
      var u = P.uniforms[name];
      if (u.type !== gl.SAMPLER_2D) return;
      var tex = null, w = 1, h = 1;

      if (name.indexOf('__sz_') === 0) return;   // companion handled below

      var p = S.paramMap[name];
      if (p && p.kind === 'texture') {
        if (p.srcType === 'buffer') {
          var b = S.buffers.get(name);
          tex = b ? b.tex : S.content; w = b ? b.w : S.width; h = b ? b.h : S.height;
        } else if (p.srcType === 'image') {
          var im = S.images[name];
          if (im && im.tex) { tex = im.tex; w = im.width; h = im.height; }
          else { tex = S.content; w = S.width; h = S.height; }
        } else if (p.srcType === 'comp') {
          tex = S.comp || S.content; w = S.width; h = S.height;
        } else {
          tex = S.content; w = S.width; h = S.height;
        }
      } else {
        tex = S.content; w = S.width; h = S.height;   // unknown sampler -> content
      }
      if (!tex) tex = S.content;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(u.loc, unit);
      bound[name] = tex;
      sizes['__sz_' + name] = [w, h];
      unit++;
    });

    // every other active uniform
    Object.keys(P.uniforms).forEach(function (name) {
      var u = P.uniforms[name];
      if (u.type === gl.SAMPLER_2D) return;

      if (name.indexOf('__sz_') === 0) {
        var s = sizes[name];
        if (s) gl.uniform2f(u.loc, s[0], s[1]);
        return;
      }
      var g = S.globals[name];
      if (g !== undefined) { self_set(gl, u, g); return; }
      var v = S.values[name];
      if (v !== undefined) { self_set(gl, u, v); return; }
      if (S.extra && S.extra[name] !== undefined) { self_set(gl, u, S.extra[name]); return; }
      // declared but unvalued -> leave at 0, but remember (helps debugging)
      S.warnings && S.warnings.push('no value for uniform ' + name);
    });

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    function self_set(g, u, val) {
      switch (u.type) {
        case g.FLOAT:          g.uniform1f(u.loc, +val || 0); break;
        case g.FLOAT_VEC2:     g.uniform2f(u.loc, val[0] || 0, val[1] || 0); break;
        case g.FLOAT_VEC3:     g.uniform3f(u.loc, val[0] || 0, val[1] || 0, val[2] || 0); break;
        case g.FLOAT_VEC4:     g.uniform4f(u.loc, val[0] || 0, val[1] || 0, val[2] || 0, val[3] || 0); break;
        case g.INT:
        case g.BOOL:           g.uniform1i(u.loc, typeof val === 'boolean' ? (val ? 1 : 0) : (+val | 0)); break;
        case g.FLOAT_MAT3:     g.uniformMatrix3fv(u.loc, false, val); break;
        case g.FLOAT_MAT4:     g.uniformMatrix4fv(u.loc, false, val); break;
        default: break;
      }
    }
  };

  /* ------------------------------------------------------------------- blit */
  Engine.prototype.blit = function (srcTex, target, w, h) {
    var gl = this.gl, self = this;
    if (!this._blit) {
      var vs = compile(gl, gl.VERTEX_SHADER,
        'attribute vec4 acPos;attribute vec2 acTexcoord;varying vec2 uv;' +
        'void main(){gl_Position=acPos;uv=acTexcoord;}', 'blit.vert');
      var fs = compile(gl, gl.FRAGMENT_SHADER,
        'precision mediump float;uniform sampler2D src;varying vec2 uv;' +
        'void main(){gl_FragColor=texture2D(src,uv);}', 'blit.frag');
      this._blit = link(gl, vs, fs, 'blit');
      gl.deleteShader(vs); gl.deleteShader(fs);
    }
    var P = this._blit;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(P);
    this._bindQuad(P);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(gl.getUniformLocation(P, 'src'), 0);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  /* ----------------------------------------------------------------- helpers */
  Engine.prototype.sizeOf = function (tex) {
    // WebGL gives no texture size API; callers track it. Fallback: target pool.
    return null;
  };

  Engine.prototype.dispose = function () {
    var gl = this.gl;
    this.targets.forEach(function (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); });
    this.targets.clear();
    this.programs.forEach(function (p) { gl.deleteProgram(p.prog); });
    this.programs.clear();
  };

  global.AMFX = {
    Engine: Engine,
    VERSION: 1,
    CONTRACT: [
      'acScreenNorm', 'acScreenSize', 'acLayerSize', 'acLayerCenter',
      'acLayerCenterNorm', 'acLayerPivot', 'acLayerSizeNorm', 'acPreviewSize',
      'acProjectSize', 'acVelocity', 'acTime', 'acAngularVelocity',
      'acScaleVelocity', 'acScreenToLayer', 'acLayerToScreen', 'acLTS',
      'acShowGuides', 'acPass', 'texture2DCv', 'getTexSize', 'saturate'
    ]
  };
})(typeof window !== 'undefined' ? window : this);
