/* ============================================================================
   ALIGHT MOTION PC STUDIO — STITCH "STUDIO KINETIC DARK" + REA NATIVE FX ENGINE
   ============================================================================ */
(() => {
  'use strict';

  // Clear legacy caches
  try {
    if ('caches' in window) {
      caches.keys().then((names) => {
        names.forEach((n) => {
          if (n.startsWith('open-motion-pwa-')) caches.delete(n);
        });
      });
    }
  } catch (_) {}

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));
  }

  function getMetaForSpec(spec) {
    const metaMap = window.AM_EFFECTS_META || {};
    const builtinMap = window.AM_BUILTIN_META || {};
    if (!spec) return null;
    if (spec.amEffectId && metaMap[spec.amEffectId]) {
      return metaMap[spec.amEffectId];
    }
    if (spec.amEffectId) {
      const baseId = String(spec.amEffectId).replace(/\d+$/, '');
      for (const suffix of ['4', '3', '2', '']) {
        if (metaMap[baseId + suffix]) return metaMap[baseId + suffix];
      }
    }
    const b = builtinMap[spec.id];
    if (b && b.amId && metaMap[b.amId]) {
      return { ...metaMap[b.amId], thumb: b.thumb || metaMap[b.amId].thumb };
    }
    if (b) {
      return {
        id: spec.id,
        name: spec.name,
        category: spec.category,
        thumb: b.thumb,
        uiItems: [],
        presets: []
      };
    }
    return null;
  }

  function getThumbForSpec(spec) {
    const meta = getMetaForSpec(spec);
    if (meta && meta.thumb) return meta.thumb;
    return 'assets/effects/thumb/gaussian_blur_bg.webp';
  }

  function classifyEffectCategory(spec) {
    const id = String(spec?.amEffectId || spec?.id || '').toLowerCase();
    const name = String(spec?.name || '').toLowerCase();
    const cat = String(spec?.category || '').toLowerCase();
    if (id.includes('blur') || name.includes('blur') || cat.includes('blur')) return 'blur';
    if (id.includes('repeat') || id.includes('echokf') || name.includes('repeat') || name.includes('echo')) return 'repeat';
    if (id.includes('text') || name.includes('text') || name.includes('teks')) return 'text';
    if (id.includes('drawing') || id.includes('stroke') || id.includes('border') || id.includes('contour') || name.includes('drawing') || name.includes('edge')) return 'drawing';
    if (id.includes('luma') || id.includes('chroma') || id.includes('matte') || id.includes('mask') || name.includes('key')) return 'matte';
    if (id.includes('warp') || id.includes('wave') || id.includes('swirl') || id.includes('pinch') || id.includes('bend') || id.includes('morph') || id.includes('displace') || id.includes('tile') || id.includes('mirror') || id.includes('turbulent') || cat.includes('distort')) return 'warp';
    if (id.includes('color') || id.includes('glow') || id.includes('exposure') || id.includes('gamma') || id.includes('hue') || id.includes('hsb') || id.includes('vignette') || id.includes('light') || id.includes('rays') || id.includes('shadow') || cat.includes('color') || cat.includes('warna')) return 'color';
    if (id.includes('path') || id.includes('parent') || id.includes('oscillate') || id.includes('swing') || id.includes('jitter') || id.includes('spin') || id.includes('shake') || id.includes('transform') || id.includes('flip') || id.includes('3d') || id.includes('cube') || id.includes('sphere') || cat.includes('gerak')) return 'transform';
    return 'other';
  }

  function getSubtypeUnit(subtype) {
    switch (String(subtype || '').toLowerCase()) {
      case 'angle':
      case 'angle-range':
        return '°';
      case 'percent':
      case 'relative-percent':
        return '%';
      case 'hz':
        return 'Hz';
      case 'rpm':
        return 'RPM';
      case 'seconds':
        return 's';
      case 'kelvin':
        return 'K';
      default:
        return '';
    }
  }

  function parseAlightShareUrl(rawInput) {
    const text = String(rawInput || '').trim();
    if (!text) return null;
    const directShare = text.match(/\/am\/share\/u\/([^/?#]+)\/p\/([^/?#]+)/i);
    if (directShare) {
      const uid = directShare[1];
      const pidRaw = directShare[2];
      const pidClean = pidRaw.replace(/-(?:[0-9a-fA-F]{6,})$/, '');
      const zipPath = `share/u/${uid}/p/${pidClean}.amproj`;
      const firebaseZipUrl = `https://firebasestorage.googleapis.com/v0/b/alight-creative.appspot.com/o/${encodeURIComponent(zipPath)}?alt=media`;
      return {
        type: 'share',
        uid,
        pidRaw,
        pidClean,
        canonicalUrl: `https://alightcreative.com/am/share/u/${uid}/p/${pidRaw}`,
        firebaseZipUrl
      };
    }
    return {
      type: 'shortlink',
      rawUrl: text
    };
  }

  // ==========================================================================
  // 1. HYDRATE EFFECT CATALOG WITH REVERSE-ENGINEERED NATIVE AM METADATA
  // ==========================================================================
  function hydrateEffectCatalogWithNativeSchema() {
    const bridge = window.omsPcBridge;
    if (!bridge) return;
    const catalog = bridge.catalog() || [];
    for (const spec of catalog) {
      if (spec._amSchemaHydrated) continue;
      const meta = getMetaForSpec(spec);
      if (!meta) continue;
      spec.amThumb = meta.thumb;
      spec.amPresets = meta.presets || [];
      spec.amUiItems = meta.uiItems || [];

      if (spec.amUiItems.length && Array.isArray(spec.params)) {
        let currentSection = '';
        const itemById = new Map();
        const enableTargetControllers = new Map(); // slaveParamId -> [{controllerId, values}]

        for (const item of spec.amUiItems) {
          if (item.widget === 'section') {
            currentSection = item.text || '';
            continue;
          }
          if (!item.id) continue;
          itemById.set(item.id, { ...item, section: currentSection });

          if (item.widget === 'switch' && Array.isArray(item.enableTargets) && item.enableTargets.length) {
            for (const targetId of item.enableTargets) {
              if (!enableTargetControllers.has(targetId)) enableTargetControllers.set(targetId, []);
              enableTargetControllers.get(targetId).push({ param: item.id, values: [1] });
            }
          }
          if (item.widget === 'selector' && Array.isArray(item.choices)) {
            for (const ch of item.choices) {
              if (Array.isArray(ch.enableTargets) && ch.enableTargets.length) {
                for (const targetId of ch.enableTargets) {
                  if (!enableTargetControllers.has(targetId)) enableTargetControllers.set(targetId, []);
                  const existing = enableTargetControllers.get(targetId).find(c => c.param === item.id);
                  if (existing) {
                    if (!existing.values.includes(Number(ch.value))) existing.values.push(Number(ch.value));
                  } else {
                    enableTargetControllers.get(targetId).push({ param: item.id, values: [Number(ch.value)] });
                  }
                }
              }
            }
          }
        }

        for (const param of spec.params) {
          const baseId = param.amParamId || param.id;
          const uiItem = itemById.get(baseId);
          if (!uiItem) continue;

          param.amWidget = uiItem.widget;
          param.amSubtype = uiItem.subtype || 'float';
          param.amUnit = getSubtypeUnit(uiItem.subtype);
          param.amTicks = uiItem.ticks || null;
          param.amSnap = uiItem.snap || null;
          param.amStyle = uiItem.style || null;

          // Authentic Alight Motion percent display scaling (0..1 -> 0..100%)
          if ((uiItem.subtype === 'percent' || uiItem.subtype === 'relative-percent') && Number(param.max) <= 10 && (!param.displayScale || param.displayScale === 1)) {
            param.displayScale = 100;
            if (!param.step || param.step < 0.005) param.step = 0.01;
          }

          // Section grouping from <section> tag in XML
          if (uiItem.section && (!param.group || param.group === '')) {
            param.group = uiItem.section;
          }

          // Conditional visibility from enableTargets in <switch> and <selector><choice>
          const conds = enableTargetControllers.get(baseId);
          if (conds && conds.length && !param.visibleWhen) {
            param.visibleWhen = conds.length === 1 ? conds[0] : { all: conds };
          }
        }
      }
      spec._amSchemaHydrated = true;
    }
  }

  // ==========================================================================
  // 2. PATCH NATIVE INSPECTOR & EFFECT BROWSER TO USE REAL APK THUMBNAILS & PRESETS
  // ==========================================================================
  function patchInspectorWithNativeAM() {
    const ui = window.ui;
    const bridge = window.omsPcBridge;
    if (!ui || !bridge || ui._amNativePatched) return;
    ui._amNativePatched = true;

    // 2A. Patch ui.effectBrowserHTML so the native "#drawer" Add Effect browser shows real APK thumbnails
    const origBrowserHTML = ui.effectBrowserHTML?.bind(ui);
    if (origBrowserHTML) {
      ui.effectBrowserHTML = function () {
        hydrateEffectCatalogWithNativeSchema();
        const html = origBrowserHTML();
        const tpl = document.createElement('template');
        tpl.innerHTML = html;
        tpl.content.querySelectorAll('[data-effect-library]').forEach((card) => {
          const specId = card.getAttribute('data-effect-library');
          const spec = bridge.spec(specId);
          if (!spec) return;
          const thumbUrl = getThumbForSpec(spec);
          const glyphEl = card.querySelector('.effectGlyph');
          if (glyphEl && thumbUrl) {
            const img = document.createElement('img');
            img.className = 'am-native-lib-thumb';
            img.src = thumbUrl;
            img.alt = spec.name || specId;
            img.loading = 'lazy';
            glyphEl.replaceWith(img);
          }
        });
        return tpl.innerHTML;
      };
    }

    // 2B. Patch ui.effectInstanceHTML to inject:
    // - Real APK Thumbnail in Effect Card Header
    // - Official Alight Motion Built-in Presets Strip (Standard Settings + Named Presets from APK)
    // - Authentic Widget Controls:
    //   * <spinner> -> Integrated Scrub Ruler with Unit Badge (°, %, Hz, s, RPM)
    //   * <slider> -> Bounded Range Track Bar
    //   * <switch> -> Native Toggle Switch (hide keyframe diamond per AM UserParameter)
    //   * <color> -> Native Color Swatch Picker + Hex Readout synced to R/G/B/A channels
    const origCardHTML = ui.effectInstanceHTML.bind(ui);
    ui.effectInstanceHTML = function (layer, inst, ...args) {
      hydrateEffectCatalogWithNativeSchema();
      const rawHtml = origCardHTML(layer, inst, ...args);
      const spec = bridge.spec(inst?.specId);
      if (!spec) return rawHtml;

      const tpl = document.createElement('template');
      tpl.innerHTML = rawHtml;
      const card = tpl.content.querySelector('.effectCard');
      if (!card) return rawHtml;

      // 1. Real APK Thumbnail inside .effectCardTitle so .effectCardHead grid columns stay aligned
      const thumbUrl = getThumbForSpec(spec);
      const titleBox = card.querySelector('.effectCardTitle');
      if (titleBox && thumbUrl && !titleBox.querySelector('.am-native-card-thumb')) {
        const textWrap = document.createElement('div');
        textWrap.className = 'am-native-card-title-text';
        while (titleBox.firstChild) {
          textWrap.appendChild(titleBox.firstChild);
        }
        const img = document.createElement('img');
        img.className = 'am-native-card-thumb';
        img.src = thumbUrl;
        img.alt = spec.name || '';
        titleBox.classList.add('am-has-thumb');
        titleBox.appendChild(img);
        titleBox.appendChild(textWrap);
      }

      // 2. Official Alight Motion Built-In Presets Bar (from assets/effects/presets/*.xml)
      const paramsContainer = card.querySelector('.effectParams');
      const presets = spec.amPresets || [];
      if (paramsContainer && presets.length > 0 && !card.querySelector('.am-native-preset-bar')) {
        const activeTitle = inst.amActivePresetTitle || 'Standard Settings';
        const presetBar = document.createElement('div');
        presetBar.className = 'am-native-preset-bar';
        presetBar.innerHTML = `
          <div class="am-native-preset-bar-label">
            <span>◆ Preset Bawaan Alight Motion</span>
            <span style="color:var(--am-accent-emerald)">${escapeHtml(activeTitle)}</span>
          </div>
          <div class="am-native-preset-chips">
            <button type="button" class="am-native-preset-chip ${activeTitle === 'Standard Settings' ? 'active' : ''}" data-am-preset-idx="-1">Standard Settings</button>
            ${presets.map((p, idx) => `
              <button type="button" class="am-native-preset-chip ${activeTitle === p.title ? 'active' : ''}" data-am-preset-idx="${idx}">${escapeHtml(p.title)}</button>
            `).join('')}
          </div>
        `;
        paramsContainer.prepend(presetBar);
      }

      // 3. Authentic Parameter Widget Styling & Color Swatch Grouping
      const colorGroupsInjected = new Set();
      card.querySelectorAll('.effectParamRow').forEach((row) => {
        const paramId = row.dataset.effectParamId;
        const param = (spec.params || []).find(p => p.id === paramId);
        if (!param) return;

        // Add Unit Badge (° / % / Hz / RPM / s) inside a wrapper around .effectParamNumber so 4-column grid stays intact
        if (param.amUnit) {
          const numInput = row.querySelector('.effectParamNumber');
          if (numInput && !row.querySelector('.am-native-unit-badge')) {
            const numWrap = document.createElement('div');
            numWrap.className = 'am-native-num-wrap';
            numInput.parentNode.insertBefore(numWrap, numInput);
            numWrap.appendChild(numInput);
            const unitSpan = document.createElement('span');
            unitSpan.className = 'am-native-unit-badge';
            unitSpan.textContent = param.amUnit;
            numWrap.appendChild(unitSpan);
          }
        }

        // In Alight Motion, <switch> booleans do NOT have keyframe diamonds
        if (param.amWidget === 'switch' || param.type === 'BOOL') {
          const kfBtn = row.querySelector('[data-effect-key]');
          if (kfBtn) kfBtn.style.display = 'none';
        }

        // Group R/G/B/A components of <color> into a unified Color Swatch Picker bar above the R row
        if (param.amType === 'color' && param.amParamId && !colorGroupsInjected.has(param.amParamId)) {
          colorGroupsInjected.add(param.amParamId);
          const colorParts = (spec.params || []).filter(p => p.amParamId === param.amParamId);
          if (colorParts.length >= 3) {
            const rVal = Math.round(Math.max(0, Math.min(1, Number(bridge.rawValue(layer, inst, colorParts[0].id)) || 0)) * 255);
            const gVal = Math.round(Math.max(0, Math.min(1, Number(bridge.rawValue(layer, inst, colorParts[1].id)) || 0)) * 255);
            const bVal = Math.round(Math.max(0, Math.min(1, Number(bridge.rawValue(layer, inst, colorParts[2].id)) || 0)) * 255);
            const hex = '#' + [rVal, gVal, bVal].map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase();
            const swatchBar = document.createElement('div');
            swatchBar.className = 'am-native-color-bar';
            swatchBar.innerHTML = `
              <label>🎨 ${escapeHtml(param.group || param.amParamId)}</label>
              <div class="am-native-color-picker-wrap">
                <input type="color" class="am-native-color-input" data-am-color-group="${escapeHtml(param.amParamId)}" value="${hex}">
                <span class="am-native-color-hex" data-am-color-hex="${escapeHtml(param.amParamId)}">${hex}</span>
              </div>
            `;
            row.parentNode.insertBefore(swatchBar, row);
          }
        }
      });

      return tpl.innerHTML;
    };

    // 2C. Bind Preset Chips & Color Swatches in ui.bindEffectStack
    const origBindStack = ui.bindEffectStack?.bind(ui);
    if (origBindStack) {
      ui.bindEffectStack = function (layer, ...args) {
        const res = origBindStack(layer, ...args);
        const drawer = document.getElementById('drawer');
        if (!drawer || !layer) return res;

        drawer.querySelectorAll('.effectCard').forEach((card) => {
          const instId = card.dataset.effectInstance;
          const stack = bridge.ensureStack(layer);
          const inst = stack.find(i => i.instanceId === instId);
          if (!inst) return;
          const spec = bridge.spec(inst.specId);
          if (!spec) return;

          // Bind Official AM Preset Chips
          card.querySelectorAll('[data-am-preset-idx]').forEach((btn) => {
            btn.onclick = (e) => {
              e.stopPropagation();
              const idx = parseInt(btn.getAttribute('data-am-preset-idx'), 10);
              if (idx < 0) {
                bridge.applyNativePreset(layer, inst, { title: 'Standard Settings', props: {} });
              } else if (spec.amPresets && spec.amPresets[idx]) {
                bridge.applyNativePreset(layer, inst, spec.amPresets[idx]);
              }
            };
          });

          // Bind Unified Color Picker Swatches
          card.querySelectorAll('[data-am-color-group]').forEach((colorInput) => {
            const amParamId = colorInput.getAttribute('data-am-color-group');
            const hexLabel = card.querySelector(`[data-am-color-hex="${amParamId}"]`);
            const parts = (spec.params || []).filter(p => p.amParamId === amParamId);
            let pushed = false;
            colorInput.oninput = (e) => {
              const hex = String(e.target.value || '#ffffff');
              if (hexLabel) hexLabel.textContent = hex.toUpperCase();
              const r = parseInt(hex.slice(1, 3), 16) / 255;
              const g = parseInt(hex.slice(3, 5), 16) / 255;
              const b = parseInt(hex.slice(5, 7), 16) / 255;
              if (parts[0]) bridge.setParamValue(layer, inst, parts[0].id, r, { pushHistory: !pushed });
              pushed = true;
              if (parts[1]) bridge.setParamValue(layer, inst, parts[1].id, g, { pushHistory: false });
              if (parts[2]) bridge.setParamValue(layer, inst, parts[2].id, b, { pushHistory: false });
            };
            colorInput.onchange = () => {
              pushed = false;
              window.timeline?.rebuild?.();
            };
          });
        });

        return res;
      };
    }
  }

  // ==========================================================================
  // 2D. NATIVE ALIGHT MOTION MOVE & TRANSFORM STUDIO (REVERSE-ENGINEERED)
  // ==========================================================================
  function patchTransformWithNativeAM() {
    const ui = window.ui;
    const model = window.model;
    const renderer = window.renderer;
    const timeline = window.timeline;
    if (!ui || ui._amNativeTransformPatched) return;
    ui._amNativeTransformPatched = true;

    const safePushHistory = () => {
      try {
        (window.omsHistory || window.historyManager)?.push?.();
      } catch (_) {}
    };

    // Authentic Alight Motion APK Vector Icons
    const ICONS = {
      move: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M11.213,12.787l0,4.852l-1.574,0l2.361,2.361l2.361,-2.361l-1.574,0l0,-4.852l4.852,0l0,1.574l2.361,-2.361l-2.361,-2.361l0,1.574l-4.852,0l0,-4.852l1.574,0l-2.361,-2.361l-2.361,2.361l1.574,0l0,4.852l-4.852,0l0,-1.574l-2.361,2.361l2.361,2.361l0,-1.574z"/></svg>`,
      rotate: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M14.945,5.711C17.158,6.763 18.741,8.914 18.985,11.467L20,11.467C19.655,7.285 16.17,4 11.913,4L11.467,4.02L14.045,6.607L14.945,5.711ZM9.055,18.289C6.842,17.244 5.259,15.086 5.015,12.533L4,12.533C4.345,16.715 7.83,20 12.087,20L12.533,19.98L9.955,17.393L9.055,18.289Z"/></svg>`,
      scale: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M17,18L17,7L6,7L6,4L20,4L20,18L17,18ZM13,19L13,11L5,11L5,8L16,8L16,19L13,19ZM4,12L12,12L12,20L4,20L4,12Z"/></svg>`,
      skew: `<svg viewBox="0 0 48 48" width="20" height="20" fill="currentColor"><path d="M20,12.8l20,0l-12,22l-20,0z"/><path d="M10.67,39.17C11.8,39.17 14.53,39.17 18.88,39.17L18.88,38L6,38L11.98,42.68C11.11,41.12 10.67,39.95 10.67,39.17Z"/><path d="M37.21,8.51C36.08,8.51 33.35,8.51 29,8.51L29,9.68L41.88,9.68L35.9,5C36.77,6.56 37.21,7.73 37.21,8.51Z"/></svg>`,
      pivot: `<svg viewBox="0 0 84 84" width="20" height="20" fill="currentColor"><path d="M41,49C36.3056,49 32.5,45.1944 32.5,40.5C32.5,35.8056 36.3056,32 41,32C45.6944,32 49.5,35.8056 49.5,40.5C49.5,45.1944 45.6944,49 41,49Z"/><path d="M7.3854,42.6085L15.2312,50.4532C16.0123,51.2342 16.0124,52.5005 15.2314,53.2816C14.4504,54.0627 13.1841,54.0628 12.403,53.2818L1.1757,42.0561C0.7937,41.6919 0.5557,41.178 0.5557,40.6085C0.5557,40.0429 0.7904,39.5322 1.1678,39.1684L12.4029,27.9333C13.184,27.1523 14.4503,27.1523 15.2313,27.9333C16.0124,28.7144 16.0124,29.9807 15.2313,30.7617L7.3846,38.6085L25.4437,38.6085C26.5483,38.6085 27.4437,39.5039 27.4437,40.6085C27.4437,41.7131 26.5483,42.6085 25.4437,42.6085L7.3854,42.6085ZM75.0456,38.6066L67.1998,30.7618C66.4187,29.9808 66.4186,28.7145 67.1996,27.9334C67.9806,27.1523 69.2469,27.1522 70.028,27.9332L81.2553,39.1589C81.6373,39.5232 81.8753,40.0371 81.8753,40.6066C81.8753,41.1721 81.6406,41.6829 81.2632,42.0467L70.0281,53.2817C69.247,54.0628 67.9807,54.0628 67.1997,53.2817C66.4186,52.5007 66.4186,51.2344 67.1997,50.4533L75.0464,42.6066L56.9873,42.6066C55.8828,42.6066 54.9873,41.7111 54.9873,40.6066C54.9873,39.502 55.8828,38.6066 56.9873,38.6066L75.0456,38.6066ZM42.9998,74.2231L50.8446,66.3773C51.6256,65.5961 52.8919,65.5961 53.673,66.377C54.4541,67.158 54.4542,68.4244 53.6732,69.2055L42.4475,80.4328C42.0832,80.8148 41.5693,81.0528 40.9998,81.0528C40.4342,81.0528 39.9234,80.818 39.5596,80.4405L28.3262,69.2055C27.5452,68.4244 27.5453,67.158 28.3264,66.377C29.1075,65.5961 30.3738,65.5961 31.1548,66.3773L38.9998,74.2234L38.9998,56.1648C38.9998,55.0602 39.8953,54.1648 40.9998,54.1648C42.1044,54.1648 42.9998,55.0602 42.9998,56.1648L42.9998,74.2231ZM38.9995,7.4008L31.1548,15.2466C30.3738,16.0277 29.1075,16.0278 28.3264,15.2468C27.5453,14.4658 27.5452,13.1995 28.3262,12.4184L39.5519,1.1911C39.9161,0.8091 40.43,0.571 40.9995,0.571C41.5652,0.571 42.0759,0.8059 42.4397,1.1833L53.6732,12.4184C54.4542,13.1995 54.4541,14.4658 53.673,15.2468C52.8919,16.0278 51.6256,16.0277 50.8446,15.2466L42.9995,7.4004L42.9995,25.459C42.9995,26.5636 42.1041,27.459 40.9995,27.459C39.895,27.459 38.9995,26.5636 38.9995,25.459L38.9995,7.4008Z"/></svg>`,
      curve: `<svg viewBox="0 0 128 128" width="20" height="20" fill="currentColor"><path d="M69.652,26.87C69.652,30.139 67.003,32.787 63.735,32.787C60.467,32.787 57.817,30.139 57.817,26.87C57.817,23.602 60.467,20.952 63.735,20.952C67.003,20.952 69.652,23.602 69.652,26.87ZM69.652,103.061C69.652,106.329 67.003,108.978 63.735,108.978C60.467,108.978 57.817,106.329 57.817,103.061C57.817,99.792 60.467,97.143 63.735,97.143C67.003,97.143 69.652,99.792 69.652,103.061Z"/><path fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" d="M97.723,26.988C88.407,27.726 63,32.697 63,64.966C63,96.434 37.006,101.907 27.962,102.86"/></svg>`,
      prev: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>`,
      next: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>`
    };

    function getTransformModeProps(l, mode) {
      if (mode === 'position') {
        return (l?.type === 'camera' || l?.is3D) ? ['x', 'y', 'z'] : ['x', 'y'];
      }
      if (mode === 'rotation') {
        return (l?.type === 'camera' || l?.is3D) ? ['pitch', 'yaw', 'roll'] : ['rotation'];
      }
      if (mode === 'scale') {
        return ['scaleX', 'scaleY'];
      }
      if (mode === 'skew') {
        return ['skewX', 'skewY'];
      }
      if (mode === 'pivot') {
        return ['amPivotX', 'amPivotY'];
      }
      return ['x', 'y'];
    }

    function isModeKeyedAtTime(l, mode, time) {
      if (!l || !l.kf) return false;
      const props = getTransformModeProps(l, mode);
      return props.some((prop) => {
        const arr = l.kf[prop] || [];
        return arr.some((k) => Math.abs(k.t - time) <= 0.015);
      });
    }

    function getPrevKeyTime(l, mode, time) {
      if (!l || !l.kf) return null;
      const props = getTransformModeProps(l, mode);
      let best = -Infinity;
      for (const prop of props) {
        const arr = l.kf[prop] || [];
        for (const k of arr) {
          if (k.t < time - 0.015 && k.t > best) best = k.t;
        }
      }
      return best === -Infinity ? null : best;
    }

    function getNextKeyTime(l, mode, time) {
      if (!l || !l.kf) return null;
      const props = getTransformModeProps(l, mode);
      let best = Infinity;
      for (const prop of props) {
        const arr = l.kf[prop] || [];
        for (const k of arr) {
          if (k.t > time + 0.015 && k.t < best) best = k.t;
        }
      }
      return best === Infinity ? null : best;
    }

    // Override transformHTML with authentic Alight Motion layout
    ui.transformHTML = function (l) {
      if (this.transformEaseEditorOpen) {
        const easeName = this.transformModeEasingName?.(l) || 'linear';
        const actions = `
          <div class="am-tf-key-rail">
            <button type="button" class="am-tf-key-btn active" id="amTfBackFromEase" title="Kembali ke Transform Studio">
              ${ICONS.curve}
              <span>KEMBALI</span>
            </button>
          </div>
        `;
        return `
          <div class="drawerBody" style="padding:4px;">
            <div class="transformStudio easeEditing">
              ${actions}
              <div class="transformMain">${this.transformEaseEditorHTML(l)}</div>
              ${this.transformEasePresetRailHTML(l)}
            </div>
          </div>
        `;
      }

      const mode = this.transformMode || 'position';
      const time = model.time || 0;
      const isKeyed = isModeKeyedAtTime(l, mode, time);
      const prevTime = getPrevKeyTime(l, mode, time);
      const nextTime = getNextKeyTime(l, mode, time);

      // Current property values
      const posX = Number(model.prop(l, 'x', time)) || 0;
      const posY = Number(model.prop(l, 'y', time)) || 0;
      const posZ = Number(model.prop(l, 'z', time)) || 0;
      const rot = Number(model.prop(l, 'rotation', time)) || 0;
      const scX = Number(model.prop(l, 'scaleX', time)) || 1;
      const scY = Number(model.prop(l, 'scaleY', time)) || 1;
      const skX = Number(model.prop(l, 'skewX', time)) || 0;
      const skY = Number(model.prop(l, 'skewY', time)) || 0;
      const pivX = Number(model.prop(l, 'amPivotX', time)) || 0;
      const pivY = Number(model.prop(l, 'amPivotY', time)) || 0;

      const layerW = l.w || 200;
      const layerH = l.h || 200;
      const pixelW = (layerW * scX).toFixed(1);
      const pixelH = (layerH * scY).toFixed(1);
      const scalePercent = Math.round(scX * 100);
      const isScaleLocked = this.transformScaleLock !== false;

      // Left Rail: Keyframe Controls (Authentic Native AM action rail)
      const keyRailHTML = `
        <div class="am-tf-key-rail">
          <button type="button" class="am-tf-key-btn" id="amTfPrevKey" ${prevTime === null ? 'disabled' : ''} title="${prevTime !== null ? `Lompat ke keyframe sebelumnya (${prevTime.toFixed(2)}s)` : 'Tidak ada keyframe sebelumnya'}">
            ${ICONS.prev}
          </button>
          <button type="button" class="am-tf-key-btn am-tf-diamond-btn ${isKeyed ? 'am-tf-kf-active' : ''}" id="amTfToggleKey" title="${isKeyed ? 'Hapus Keyframe pada playhead ini' : 'Tambah Keyframe pada playhead ini'}">
            <span class="am-tf-diamond-icon">${isKeyed ? '◆' : '◇'}</span>
          </button>
          <button type="button" class="am-tf-key-btn" id="amTfNextKey" ${nextTime === null ? 'disabled' : ''} title="${nextTime !== null ? `Lompat ke keyframe berikutnya (${nextTime.toFixed(2)}s)` : 'Tidak ada keyframe berikutnya'}">
            ${ICONS.next}
          </button>
          <div class="am-tf-key-rail-divider"></div>
          <button type="button" class="am-tf-key-btn curve" id="amTfOpenEase" title="Buka Kurva Animasi (Easing Graph Editor)">
            ${ICONS.curve}
          </button>
        </div>
      `;

      // Center Workspace Content per Mode
      let workspaceHTML = '';

      if (mode === 'position') {
        workspaceHTML = `
          <div class="am-tf-card-header">
            <span class="am-tf-card-title">POSISI (MOVE)</span>
            <span class="am-tf-card-badge">${l.transformSpace ? l.transformSpace.toUpperCase() : 'LOCAL'}</span>
          </div>
          <div class="am-tf-readout-grid">
            <div class="am-tf-readout-item">
              <label>X (Horizontal)</label>
              <div class="am-tf-num-box">
                <input type="number" step="1" id="amTfInpX" value="${posX.toFixed(1)}">
                <span class="am-tf-unit">px</span>
              </div>
            </div>
            <div class="am-tf-readout-item">
              <label>Y (Vertikal)</label>
              <div class="am-tf-num-box">
                <input type="number" step="1" id="amTfInpY" value="${posY.toFixed(1)}">
                <span class="am-tf-unit">px</span>
              </div>
            </div>
            ${l.is3D || l.type === 'camera' ? `
              <div class="am-tf-readout-item">
                <label>Z (Depth)</label>
                <div class="am-tf-num-box">
                  <input type="number" step="1" id="amTfInpZ" value="${posZ.toFixed(1)}">
                  <span class="am-tf-unit">px</span>
                </div>
              </div>
            ` : ''}
          </div>

          <!-- Alight Motion Touch ControlPad -->
          <div class="am-tf-pad-container" id="amTfPositionPad" title="Geser di sini untuk menggeser posisi layer secara bebas">
            <div class="am-tf-pad-grid"></div>
            <div class="am-tf-pad-cursor" id="amTfPositionCursor"></div>
            <div class="am-tf-pad-hint">
              <span>✥ Geser di sini untuk memindahkan layer</span>
            </div>
            <div class="am-tf-pad-nudge-bar">
              <button type="button" class="am-tf-nudge-btn" data-nudge="up" title="Geser ke Atas (1px / Shift: 10px)">▲</button>
              <div style="display:flex;gap:4px;">
                <button type="button" class="am-tf-nudge-btn" data-nudge="left" title="Geser ke Kiri (1px / Shift: 10px)">◀</button>
                <button type="button" class="am-tf-nudge-btn" data-nudge="right" title="Geser ke Kanan (1px / Shift: 10px)">▶</button>
              </div>
              <button type="button" class="am-tf-nudge-btn" data-nudge="down" title="Geser ke Bawah (1px / Shift: 10px)">▼</button>
            </div>
          </div>

          <!-- Quick Presets -->
          <div class="am-tf-quick-actions">
            <button type="button" class="am-tf-preset-pill" data-am-pos-preset="centerX">Pusat X</button>
            <button type="button" class="am-tf-preset-pill" data-am-pos-preset="centerY">Pusat Y</button>
            <button type="button" class="am-tf-preset-pill primary" data-am-pos-preset="centerAll">Pusat Layar</button>
            <button type="button" class="am-tf-preset-pill" data-am-pos-preset="reset">Reset Posisi</button>
          </div>
        `;
      } else if (mode === 'rotation') {
        const fullTurns = Math.floor(rot / 360);
        const remDeg = (rot % 360).toFixed(1);
        const turnText = fullTurns !== 0 ? `${fullTurns}x + ` : '';
        workspaceHTML = `
          <div class="am-tf-card-header">
            <span class="am-tf-card-title">ROTASI (ROTATE)</span>
            <span class="am-tf-card-badge">${turnText}${remDeg}°</span>
          </div>
          <div class="am-tf-readout-grid">
            <div class="am-tf-readout-item" style="grid-column: 1 / -1;">
              <label>Sudut Rotasi</label>
              <div class="am-tf-num-box">
                <input type="number" step="0.5" id="amTfInpRot" value="${rot.toFixed(1)}">
                <span class="am-tf-unit">°</span>
              </div>
            </div>
          </div>

          <!-- Alight Motion RotateView Dial -->
          <div class="am-tf-rotate-wrap">
            <div class="am-tf-rotate-dial" id="amTfRotateDial" title="Tahan dan putar roda untuk merotasi layer">
              <div class="am-tf-rotate-ticks"></div>
              <div class="am-tf-rotate-needle" id="amTfRotateNeedle" style="transform: rotate(${rot}deg);">
                <div class="am-tf-rotate-knob"></div>
              </div>
              <div class="am-tf-rotate-center-badge">${rot.toFixed(1)}°</div>
            </div>
          </div>

          <!-- Quick Presets -->
          <div class="am-tf-quick-actions">
            <button type="button" class="am-tf-preset-pill" data-am-rot-preset="0">0°</button>
            <button type="button" class="am-tf-preset-pill" data-am-rot-preset="90">+90°</button>
            <button type="button" class="am-tf-preset-pill" data-am-rot-preset="180">180°</button>
            <button type="button" class="am-tf-preset-pill" data-am-rot-preset="-90">-90°</button>
            <button type="button" class="am-tf-preset-pill primary" data-am-rot-preset="360">+360°</button>
            <button type="button" class="am-tf-preset-pill" data-am-rot-preset="reset">Reset 0°</button>
          </div>
        `;
      } else if (mode === 'scale') {
        workspaceHTML = `
          <div class="am-tf-card-header">
            <span class="am-tf-card-title">SKALA & UKURAN (SCALE)</span>
            <button type="button" class="am-tf-ratio-toggle ${isScaleLocked ? 'locked' : ''}" id="amTfRatioLock" title="${isScaleLocked ? 'Rasio Terkunci (Klik untuk Ubah Bebas)' : 'Rasio Bebas (Klik untuk Kunci Rasio)'}">
              ${isScaleLocked ? '🔗 Rasio Terkunci' : '⛓ Rasio Bebas'}
            </button>
          </div>
          <div class="am-tf-readout-grid">
            <div class="am-tf-readout-item">
              <label>Lebar (W)</label>
              <div class="am-tf-num-box">
                <input type="number" step="1" id="amTfInpW" value="${pixelW}">
                <span class="am-tf-unit">px</span>
              </div>
            </div>
            <div class="am-tf-readout-item">
              <label>Tinggi (H)</label>
              <div class="am-tf-num-box">
                <input type="number" step="1" id="amTfInpH" value="${pixelH}">
                <span class="am-tf-unit">px</span>
              </div>
            </div>
            <div class="am-tf-readout-item" style="grid-column:1/-1;">
              <label>Skala Relatif</label>
              <div class="am-tf-num-box">
                <input type="number" step="1" id="amTfInpScalePct" value="${scalePercent}">
                <span class="am-tf-unit">%</span>
              </div>
            </div>
          </div>

          <!-- Alight Motion Scale Vertical Pad -->
          <div class="am-tf-scale-pad-wrap" id="amTfScalePad" title="Geser ke atas untuk memperbesar, ke bawah untuk mengecilkan">
            <div class="am-tf-scale-pad-track">
              <div class="am-tf-scale-pad-handle">↕ Geser Vertikal untuk Skala</div>
            </div>
          </div>

          <!-- Quick Presets -->
          <div class="am-tf-quick-actions">
            <button type="button" class="am-tf-preset-pill" data-am-scale-preset="fit" title="Paskan ukuran layer dengan kanvas">Paskan (Fit)</button>
            <button type="button" class="am-tf-preset-pill" data-am-scale-preset="fill" title="Penuhi seluruh area kanvas">Penuhi (Fill)</button>
            <button type="button" class="am-tf-preset-pill" data-am-scale-preset="stretch" title="Regangkan sesuai ukuran kanvas">Regangkan (Stretch)</button>
            <button type="button" class="am-tf-preset-pill primary" data-am-scale-preset="reset" title="Kembalikan ke ukuran 100% asli">Reset 100%</button>
          </div>
        `;
      } else if (mode === 'skew') {
        workspaceHTML = `
          <div class="am-tf-card-header">
            <span class="am-tf-card-title">KEMIRINGAN (SKEW / SHEAR)</span>
            <span class="am-tf-card-badge">2D DISTORT</span>
          </div>
          <div class="am-tf-readout-grid">
            <div class="am-tf-readout-item">
              <label>X Skew</label>
              <div class="am-tf-num-box">
                <input type="number" step="0.5" id="amTfInpSkewX" value="${skX.toFixed(1)}">
                <span class="am-tf-unit">°</span>
              </div>
            </div>
            <div class="am-tf-readout-item">
              <label>Y Skew</label>
              <div class="am-tf-num-box">
                <input type="number" step="0.5" id="amTfInpSkewY" value="${skY.toFixed(1)}">
                <span class="am-tf-unit">°</span>
              </div>
            </div>
          </div>

          <!-- Dual Skew Scrub Sliders -->
          <div class="am-tf-skew-pad-wrap">
            <div class="am-tf-skew-rail" id="amTfSkewXRail" title="Tahan dan geser untuk X Skew">
              <span>Sumbu Horizontal X</span>
              <div class="am-tf-skew-thumb" style="left:${Math.min(95, Math.max(5, (skX + 45) / 90 * 100))}%;"></div>
            </div>
            <div class="am-tf-skew-rail" id="amTfSkewYRail" title="Tahan dan geser untuk Y Skew">
              <span>Sumbu Vertikal Y</span>
              <div class="am-tf-skew-thumb" style="left:${Math.min(95, Math.max(5, (skY + 45) / 90 * 100))}%;"></div>
            </div>
          </div>

          <!-- Quick Presets -->
          <div class="am-tf-quick-actions">
            <button type="button" class="am-tf-preset-pill" data-am-skew-preset="x15">+15° X</button>
            <button type="button" class="am-tf-preset-pill" data-am-skew-preset="x-15">-15° X</button>
            <button type="button" class="am-tf-preset-pill primary" data-am-skew-preset="reset">Reset Skew (0°)</button>
          </div>
        `;
      } else if (mode === 'pivot') {
        workspaceHTML = `
          <div class="am-tf-card-header">
            <span class="am-tf-card-title">TITIK TUMPU (PIVOT / ANCHOR)</span>
            <span class="am-tf-card-badge">SUMBU PUTAR</span>
          </div>
          <div class="am-tf-readout-grid">
            <div class="am-tf-readout-item">
              <label>Pivot X (Offset)</label>
              <div class="am-tf-num-box">
                <input type="number" step="1" id="amTfInpPivX" value="${pivX.toFixed(1)}">
                <span class="am-tf-unit">px</span>
              </div>
            </div>
            <div class="am-tf-readout-item">
              <label>Pivot Y (Offset)</label>
              <div class="am-tf-num-box">
                <input type="number" step="1" id="amTfInpPivY" value="${pivY.toFixed(1)}">
                <span class="am-tf-unit">px</span>
              </div>
            </div>
          </div>

          <!-- Interactive Pivot Pad -->
          <div class="am-tf-pivot-wrap" id="amTfPivotPad" title="Geser titik anchor untuk mengubah pusat rotasi dan skala layer">
            <div class="am-tf-pivot-box">
              <div class="am-tf-pivot-cross-h"></div>
              <div class="am-tf-pivot-cross-v"></div>
              <div class="am-tf-pivot-dot" id="amTfPivotDot" style="left: calc(50% + ${Math.max(-60, Math.min(60, pivX))}px); top: calc(50% + ${Math.max(-60, Math.min(60, pivY))}px);"></div>
            </div>
            <div class="am-tf-pad-hint"><span>Titik tumpu menentukan pusat rotasi dan skala</span></div>
          </div>

          <!-- Quick Presets -->
          <div class="am-tf-quick-actions">
            <button type="button" class="am-tf-preset-pill primary" data-am-piv-preset="center">Pusat [0, 0]</button>
            <button type="button" class="am-tf-preset-pill" data-am-piv-preset="topleft">Kiri-Atas</button>
            <button type="button" class="am-tf-preset-pill" data-am-piv-preset="topright">Kanan-Atas</button>
            <button type="button" class="am-tf-preset-pill" data-am-piv-preset="botleft">Kiri-Bawah</button>
            <button type="button" class="am-tf-preset-pill" data-am-piv-preset="botright">Kanan-Bawah</button>
          </div>
        `;
      }

      // Right Rail: 5 Native Alight Motion Mode Buttons
      const modesRailHTML = `
        <div class="am-tf-modes-rail" role="tablist">
          <button type="button" class="am-tf-mode-tab ${mode === 'position' ? 'active' : ''}" data-tf-mode="position" title="Posisi (Move)">
            ${ICONS.move}
            <small>Posisi</small>
          </button>
          <button type="button" class="am-tf-mode-tab ${mode === 'rotation' ? 'active' : ''}" data-tf-mode="rotation" title="Rotasi (Rotate)">
            ${ICONS.rotate}
            <small>Rotasi</small>
          </button>
          <button type="button" class="am-tf-mode-tab ${mode === 'scale' ? 'active' : ''}" data-tf-mode="scale" title="Skala & Ukuran (Scale)">
            ${ICONS.scale}
            <small>Skala</small>
          </button>
          <button type="button" class="am-tf-mode-tab ${mode === 'skew' ? 'active' : ''}" data-tf-mode="skew" title="Kemiringan (Skew)">
            ${ICONS.skew}
            <small>Skew</small>
          </button>
          <button type="button" class="am-tf-mode-tab ${mode === 'pivot' ? 'active' : ''}" data-tf-mode="pivot" title="Titik Tumpu (Pivot)">
            ${ICONS.pivot}
            <small>Pivot</small>
          </button>
        </div>
      `;

      return `
        <div class="drawerBody propPanel" style="padding:6px;height:100%;box-sizing:border-box;">
          <div class="am-tf-studio">
            ${keyRailHTML}
            <div class="am-tf-workspace">
              ${workspaceHTML}
            </div>
            ${modesRailHTML}
          </div>
        </div>
      `;
    };

    // Override bindTransformStudio with clean event listeners
    ui.bindTransformStudio = function (l) {
      const mode = this.transformMode || 'position';
      const time = model.time || 0;

      // 1. Right Rail Mode Tabs
      document.querySelectorAll('.am-tf-mode-tab').forEach((tab) => {
        tab.onclick = () => {
          this.transformMode = tab.getAttribute('data-tf-mode');
          this.transformEaseEditorOpen = false;
          this.openInspector('move');
        };
      });

      // 2. Left Rail Keyframe Actions
      const toggleBtn = document.getElementById('amTfToggleKey');
      if (toggleBtn) {
        toggleBtn.onclick = () => {
          safePushHistory();
          const isKeyed = isModeKeyedAtTime(l, mode, model.time);
          const props = getTransformModeProps(l, mode);
          if (isKeyed) {
            for (const prop of props) {
              if (l.kf?.[prop]) l.kf[prop] = l.kf[prop].filter(k => Math.abs(k.t - model.time) > 0.015);
            }
          } else {
            for (const prop of props) {
              model.anim.setKey(l, prop, model.time, +model.prop(l, prop) || 0);
            }
          }
          timeline.rebuild();
          renderer.render();
          this.openInspector('move');
        };
      }

      const prevBtn = document.getElementById('amTfPrevKey');
      if (prevBtn) {
        prevBtn.onclick = () => {
          const t = getPrevKeyTime(l, mode, model.time);
          if (t !== null) {
            model.time = t;
            timeline.updatePlayhead();
            renderer.render();
            this.openInspector('move');
          }
        };
      }

      const nextBtn = document.getElementById('amTfNextKey');
      if (nextBtn) {
        nextBtn.onclick = () => {
          const t = getNextKeyTime(l, mode, model.time);
          if (t !== null) {
            model.time = t;
            timeline.updatePlayhead();
            renderer.render();
            this.openInspector('move');
          }
        };
      }

      const easeBtn = document.getElementById('amTfOpenEase');
      if (easeBtn) {
        easeBtn.onclick = () => {
          this.transformEaseEditorOpen = true;
          this.openInspector('move');
        };
      }

      const backEaseBtn = document.getElementById('amTfBackFromEase');
      if (backEaseBtn) {
        backEaseBtn.onclick = () => {
          this.transformEaseEditorOpen = false;
          this.openInspector('move');
        };
      }

      // 3. Numeric Inputs
      const bindNumeric = (id, prop, transformVal = (v) => v) => {
        const inp = document.getElementById(id);
        if (!inp) return;
        inp.oninput = () => {
          const val = transformVal(Number(inp.value) || 0);
          ui.setTransformValue(l, prop, val);
          renderer.render();
        };
        inp.onchange = () => {
          safePushHistory();
          timeline.rebuild();
        };
      };

      if (mode === 'position') {
        bindNumeric('amTfInpX', 'x');
        bindNumeric('amTfInpY', 'y');
        bindNumeric('amTfInpZ', 'z');

        // Interactive Touch ControlPad Drag
        const pad = document.getElementById('amTfPositionPad');
        const cursor = document.getElementById('amTfPositionCursor');
        if (pad && cursor) {
          let dragging = false;
          let lastX = 0, lastY = 0;
          pad.onpointerdown = (e) => {
            if (e.button !== 0 && e.pointerType === 'mouse') return;
            e.preventDefault();
            pad.setPointerCapture(e.pointerId);
            dragging = true;
            lastX = e.clientX;
            lastY = e.clientY;
            cursor.classList.add('active');
          };
          pad.onpointermove = (e) => {
            if (!dragging) return;
            const dx = e.clientX - lastX;
            const dy = e.clientY - lastY;
            lastX = e.clientX;
            lastY = e.clientY;
            const curX = Number(model.prop(l, 'x')) || 0;
            const curY = Number(model.prop(l, 'y')) || 0;
            ui.setTransformValue(l, 'x', curX + dx);
            ui.setTransformValue(l, 'y', curY + dy);
            const inpX = document.getElementById('amTfInpX');
            const inpY = document.getElementById('amTfInpY');
            if (inpX) inpX.value = (curX + dx).toFixed(1);
            if (inpY) inpY.value = (curY + dy).toFixed(1);
            renderer.render();
          };
          const endDrag = (e) => {
            if (!dragging) return;
            dragging = false;
            cursor.classList.remove('active');
            safePushHistory();
            timeline.rebuild();
          };
          pad.onpointerup = endDrag;
          pad.onpointercancel = endDrag;
        }

        // Nudge Buttons
        pad?.querySelectorAll('[data-nudge]').forEach((btn) => {
          btn.onclick = (e) => {
            e.stopPropagation();
            const dir = btn.getAttribute('data-nudge');
            const step = e.shiftKey ? 10 : 1;
            const curX = Number(model.prop(l, 'x')) || 0;
            const curY = Number(model.prop(l, 'y')) || 0;
            let nx = curX, ny = curY;
            if (dir === 'up') ny -= step;
            if (dir === 'down') ny += step;
            if (dir === 'left') nx -= step;
            if (dir === 'right') nx += step;
            ui.setTransformValue(l, 'x', nx);
            ui.setTransformValue(l, 'y', ny);
            const inpX = document.getElementById('amTfInpX');
            const inpY = document.getElementById('amTfInpY');
            if (inpX) inpX.value = nx.toFixed(1);
            if (inpY) inpY.value = ny.toFixed(1);
            renderer.render();
            safePushHistory();
            timeline.rebuild();
          };
        });

        // Quick Position Presets
        document.querySelectorAll('[data-am-pos-preset]').forEach((btn) => {
          btn.onclick = () => {
            const p = btn.getAttribute('data-am-pos-preset');
            const W = model.project.width || 1080;
            const H = model.project.height || 1920;
            safePushHistory();
            if (p === 'centerX') ui.setTransformValue(l, 'x', W / 2);
            if (p === 'centerY') ui.setTransformValue(l, 'y', H / 2);
            if (p === 'centerAll') {
              ui.setTransformValue(l, 'x', W / 2);
              ui.setTransformValue(l, 'y', H / 2);
            }
            if (p === 'reset') {
              ui.setTransformValue(l, 'x', W / 2);
              ui.setTransformValue(l, 'y', H / 2);
              if (l.z !== undefined) ui.setTransformValue(l, 'z', 0);
            }
            renderer.render();
            timeline.rebuild();
            this.openInspector('move');
          };
        });
      } else if (mode === 'rotation') {
        bindNumeric('amTfInpRot', 'rotation');

        // Interactive RotateView Dial Drag
        const dial = document.getElementById('amTfRotateDial');
        const needle = document.getElementById('amTfRotateNeedle');
        if (dial && needle) {
          let rotating = false;
          const updateFromPointer = (e) => {
            const rect = dial.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const rad = Math.atan2(e.clientY - cy, e.clientX - cx);
            let deg = (rad * 180 / Math.PI) + 90;
            if (deg < 0) deg += 360;
            // Snap to 45 degree ticks if close
            const nearest45 = Math.round(deg / 45) * 45;
            if (Math.abs(deg - nearest45) < 3.5) deg = nearest45;
            ui.setTransformValue(l, 'rotation', deg);
            needle.style.transform = `rotate(${deg}deg)`;
            const inp = document.getElementById('amTfInpRot');
            if (inp) inp.value = deg.toFixed(1);
            renderer.render();
          };
          dial.onpointerdown = (e) => {
            if (e.button !== 0 && e.pointerType === 'mouse') return;
            e.preventDefault();
            dial.setPointerCapture(e.pointerId);
            rotating = true;
            updateFromPointer(e);
          };
          dial.onpointermove = (e) => {
            if (rotating) updateFromPointer(e);
          };
          const endRot = () => {
            if (!rotating) return;
            rotating = false;
            safePushHistory();
            timeline.rebuild();
          };
          dial.onpointerup = endRot;
          dial.onpointercancel = endRot;
        }

        // Quick Rotation Presets
        document.querySelectorAll('[data-am-rot-preset]').forEach((btn) => {
          btn.onclick = () => {
            const p = btn.getAttribute('data-am-rot-preset');
            safePushHistory();
            if (p === 'reset') ui.setTransformValue(l, 'rotation', 0);
            else {
              const cur = Number(model.prop(l, 'rotation')) || 0;
              const delta = Number(p);
              ui.setTransformValue(l, 'rotation', p === '0' ? 0 : (cur + delta));
            }
            renderer.render();
            timeline.rebuild();
            this.openInspector('move');
          };
        });
      } else if (mode === 'scale') {
        const inpW = document.getElementById('amTfInpW');
        const inpH = document.getElementById('amTfInpH');
        const inpPct = document.getElementById('amTfInpScalePct');
        const ratioBtn = document.getElementById('amTfRatioLock');

        if (ratioBtn) {
          ratioBtn.onclick = () => {
            this.transformScaleLock = !this.transformScaleLock;
            this.openInspector('move');
          };
        }

        const lw = l.w || 200;
        const lh = l.h || 200;

        if (inpW) {
          inpW.oninput = () => {
            const w = Math.max(1, Number(inpW.value) || 1);
            const sx = w / lw;
            ui.setTransformValue(l, 'scaleX', sx);
            if (this.transformScaleLock !== false) {
              ui.setTransformValue(l, 'scaleY', sx);
              if (inpH) inpH.value = (lh * sx).toFixed(1);
            }
            if (inpPct) inpPct.value = Math.round(sx * 100);
            renderer.render();
          };
          inpW.onchange = () => { safePushHistory(); timeline.rebuild(); };
        }

        if (inpH) {
          inpH.oninput = () => {
            const h = Math.max(1, Number(inpH.value) || 1);
            const sy = h / lh;
            ui.setTransformValue(l, 'scaleY', sy);
            if (this.transformScaleLock !== false) {
              ui.setTransformValue(l, 'scaleX', sy);
              if (inpW) inpW.value = (lw * sy).toFixed(1);
            }
            if (inpPct) inpPct.value = Math.round(sy * 100);
            renderer.render();
          };
          inpH.onchange = () => { safePushHistory(); timeline.rebuild(); };
        }

        if (inpPct) {
          inpPct.oninput = () => {
            const s = Math.max(0.01, (Number(inpPct.value) || 100) / 100);
            ui.setTransformValue(l, 'scaleX', s);
            ui.setTransformValue(l, 'scaleY', s);
            if (inpW) inpW.value = (lw * s).toFixed(1);
            if (inpH) inpH.value = (lh * s).toFixed(1);
            renderer.render();
          };
          inpPct.onchange = () => { safePushHistory(); timeline.rebuild(); };
        }

        // Vertical Scale Pad Drag
        const scalePad = document.getElementById('amTfScalePad');
        if (scalePad) {
          let dragging = false;
          let startY = 0;
          let startSx = 1, startSy = 1;
          scalePad.onpointerdown = (e) => {
            if (e.button !== 0 && e.pointerType === 'mouse') return;
            e.preventDefault();
            scalePad.setPointerCapture(e.pointerId);
            dragging = true;
            startY = e.clientY;
            startSx = Number(model.prop(l, 'scaleX')) || 1;
            startSy = Number(model.prop(l, 'scaleY')) || 1;
          };
          scalePad.onpointermove = (e) => {
            if (!dragging) return;
            const dy = startY - e.clientY;
            const factor = Math.max(0.02, 1 + dy * 0.008);
            const nextSx = startSx * factor;
            const nextSy = (this.transformScaleLock !== false) ? (startSy * factor) : startSy;
            ui.setTransformValue(l, 'scaleX', nextSx);
            ui.setTransformValue(l, 'scaleY', nextSy);
            if (inpW) inpW.value = (lw * nextSx).toFixed(1);
            if (inpH) inpH.value = (lh * nextSy).toFixed(1);
            if (inpPct) inpPct.value = Math.round(nextSx * 100);
            renderer.render();
          };
          const endScale = () => {
            if (!dragging) return;
            dragging = false;
            safePushHistory();
            timeline.rebuild();
          };
          scalePad.onpointerup = endScale;
          scalePad.onpointercancel = endScale;
        }

        // Quick Scale Presets
        document.querySelectorAll('[data-am-scale-preset]').forEach((btn) => {
          btn.onclick = () => {
            const p = btn.getAttribute('data-am-scale-preset');
            const pw = model.project.width || 1080;
            const ph = model.project.height || 1920;
            safePushHistory();
            if (p === 'reset') {
              ui.setTransformValue(l, 'scaleX', 1);
              ui.setTransformValue(l, 'scaleY', 1);
            } else if (p === 'fit') {
              const s = Math.min(pw / lw, ph / lh);
              ui.setTransformValue(l, 'scaleX', s);
              ui.setTransformValue(l, 'scaleY', s);
            } else if (p === 'fill') {
              const s = Math.max(pw / lw, ph / lh);
              ui.setTransformValue(l, 'scaleX', s);
              ui.setTransformValue(l, 'scaleY', s);
            } else if (p === 'stretch') {
              ui.setTransformValue(l, 'scaleX', pw / lw);
              ui.setTransformValue(l, 'scaleY', ph / lh);
            }
            renderer.render();
            timeline.rebuild();
            this.openInspector('move');
          };
        });
      } else if (mode === 'skew') {
        bindNumeric('amTfInpSkewX', 'skewX');
        bindNumeric('amTfInpSkewY', 'skewY');

        document.querySelectorAll('[data-am-skew-preset]').forEach((btn) => {
          btn.onclick = () => {
            const p = btn.getAttribute('data-am-skew-preset');
            safePushHistory();
            if (p === 'reset') {
              ui.setTransformValue(l, 'skewX', 0);
              ui.setTransformValue(l, 'skewY', 0);
            } else if (p === 'x15') {
              ui.setTransformValue(l, 'skewX', (Number(model.prop(l, 'skewX')) || 0) + 15);
            } else if (p === 'x-15') {
              ui.setTransformValue(l, 'skewX', (Number(model.prop(l, 'skewX')) || 0) - 15);
            }
            renderer.render();
            timeline.rebuild();
            this.openInspector('move');
          };
        });
      } else if (mode === 'pivot') {
        l.amImport = l.amImport || {}; // Ensure worldMatrix applies pivot
        bindNumeric('amTfInpPivX', 'amPivotX');
        bindNumeric('amTfInpPivY', 'amPivotY');

        // Draggable Pivot Pad
        const pivotPad = document.getElementById('amTfPivotPad');
        const pivotDot = document.getElementById('amTfPivotDot');
        if (pivotPad && pivotDot) {
          let dragging = false;
          const updatePivot = (e) => {
            const rect = pivotPad.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const px = Math.round((e.clientX - cx) * 2);
            const py = Math.round((e.clientY - cy) * 2);
            ui.setTransformValue(l, 'amPivotX', px);
            ui.setTransformValue(l, 'amPivotY', py);
            const inpX = document.getElementById('amTfInpPivX');
            const inpY = document.getElementById('amTfInpPivY');
            if (inpX) inpX.value = px;
            if (inpY) inpY.value = py;
            pivotDot.style.left = `calc(50% + ${Math.max(-60, Math.min(60, px))}px)`;
            pivotDot.style.top = `calc(50% + ${Math.max(-60, Math.min(60, py))}px)`;
            renderer.render();
          };
          pivotPad.onpointerdown = (e) => {
            if (e.button !== 0 && e.pointerType === 'mouse') return;
            e.preventDefault();
            pivotPad.setPointerCapture(e.pointerId);
            dragging = true;
            updatePivot(e);
          };
          pivotPad.onpointermove = (e) => {
            if (dragging) updatePivot(e);
          };
          const endPivot = () => {
            if (!dragging) return;
            dragging = false;
            safePushHistory();
            timeline.rebuild();
          };
          pivotPad.onpointerup = endPivot;
          pivotPad.onpointercancel = endPivot;
        }

        // Quick Pivot Presets
        document.querySelectorAll('[data-am-piv-preset]').forEach((btn) => {
          btn.onclick = () => {
            const p = btn.getAttribute('data-am-piv-preset');
            const halfW = (l.w || 200) / 2;
            const halfH = (l.h || 200) / 2;
            safePushHistory();
            if (p === 'center') {
              ui.setTransformValue(l, 'amPivotX', 0);
              ui.setTransformValue(l, 'amPivotY', 0);
            } else if (p === 'topleft') {
              ui.setTransformValue(l, 'amPivotX', -halfW);
              ui.setTransformValue(l, 'amPivotY', -halfH);
            } else if (p === 'topright') {
              ui.setTransformValue(l, 'amPivotX', halfW);
              ui.setTransformValue(l, 'amPivotY', -halfH);
            } else if (p === 'botleft') {
              ui.setTransformValue(l, 'amPivotX', -halfW);
              ui.setTransformValue(l, 'amPivotY', halfH);
            } else if (p === 'botright') {
              ui.setTransformValue(l, 'amPivotX', halfW);
              ui.setTransformValue(l, 'amPivotY', halfH);
            }
            renderer.render();
            timeline.rebuild();
            this.openInspector('move');
          };
        });
      }
    };
  }

  // ==========================================================================
  // 3. MAIN DESKTOP STUDIO INITIALIZATION (SIMPLIFIED STITCH KINETIC DARK)
  // ==========================================================================
  function initDesktopStudio() {
    const model = window.model;
    const ui = window.ui;
    const renderer = window.renderer;
    const bridge = window.omsPcBridge;

    if (!model || !ui || !renderer || !bridge) {
      setTimeout(initDesktopStudio, 80);
      return;
    }

    hydrateEffectCatalogWithNativeSchema();
    patchInspectorWithNativeAM();
    patchTransformWithNativeAM();

    const editorEl = document.getElementById('editor');
    const editorTop = editorEl?.querySelector('.editorTop');
    const editorMain = editorEl?.querySelector('.editorMain');
    const previewArea = editorMain?.querySelector('.previewArea');
    const hSplitter = document.getElementById('desktopHorizontalSplitter');
    const timelineArea = editorMain?.querySelector('.timelineArea');
    const drawerEl = document.getElementById('drawer');

    if (!editorEl || !editorMain || !previewArea || !timelineArea || !drawerEl) {
      return;
    }

    document.body.classList.add('am-pc-studio-active');
    if (window.innerWidth >= 900) {
      editorMain.style.removeProperty('grid-template-columns');
      editorMain.style.removeProperty('grid-template-rows');
    }

    try {
      if (model.project) model.project.omsSelectedLayerFocus = false;
      localStorage.setItem('oms_selected_layer_focus_v1', '0');
      localStorage.setItem('oms_hide_experimental_notice', '1');
      const expNotice = document.getElementById('experimentalNotice');
      if (expNotice) {
        expNotice.setAttribute('aria-hidden', 'true');
        expNotice.style.display = 'none';
      }
      window.__omsExperimentalNoticeAccepted = true;
    } catch (_) {}

    if (!ui._amShowEditorPatched && typeof ui.showEditor === 'function') {
      ui._amShowEditorPatched = true;
      const origShowEditor = ui.showEditor.bind(ui);
      ui.showEditor = function (...args) {
        if (!model.project && typeof model.defaultProject === 'function') {
          model.project = model.defaultProject('Proyek Studio', '16:9', 1080, 60, 10, '#000000');
          model.resetEditorCamera?.();
        }
        return origShowEditor(...args);
      };
    }

    // 1. Clean Single Top Bar (#amDesktopMenuBar) — Stitch Kinetic Dark
    const existingMenu = document.getElementById('amDesktopMenuBar');
    if (existingMenu) existingMenu.remove();

    const menuBar = document.createElement('nav');
    menuBar.id = 'amDesktopMenuBar';
    menuBar.innerHTML = `
      <div class="am-pc-menu-left">
        <button type="button" class="am-pc-brand-pill" id="amPcBtnHome" title="Kembali ke Beranda Proyek">
          <span>◆</span><span>ALIGHT MOTION STUDIO</span>
        </button>
        <button type="button" class="am-pc-project-pill" id="amPcBtnProjectTitle" title="Klik untuk ubah nama proyek">
          <span id="amPcProjectNameText">${escapeHtml(model.project?.name || 'Proyek Baru')}</span>
          <small id="amPcCompChip">1080×1920 · 60 FPS</small>
        </button>
        <button type="button" class="am-pc-menu-btn" id="amPcBtnAspect" title="Ubah Rasio & FPS Cepat">⚙ 1080p · 60fps</button>
      </div>

      <div class="am-pc-menu-center">
        <button type="button" class="am-pc-menu-btn" id="amPcBtnUndo" title="Undo (Ctrl+Z)">↶ Undo</button>
        <button type="button" class="am-pc-menu-btn" id="amPcBtnRedo" title="Redo (Ctrl+Y)">↷ Redo</button>
        <button type="button" class="am-pc-menu-btn am-pc-menu-btn-accent" id="amPcBtnOpenFxModal" title="Buka Katalog Lengkap Efek Alight Motion + Preset Bawaan">✨ + Tambah Efek</button>
        <button type="button" class="am-pc-menu-btn" id="amPcBtnOpenLinkModal" title="Impor Link Preset Alight Creative">🔗 Impor Link AM</button>
        <button type="button" class="am-pc-menu-btn" id="amPcBtnImportXml" title="Impor File Proyek (.xml / .amproj / .zip)">📥 Impor XML/ZIP</button>
      </div>

      <div class="am-pc-menu-right">
        <button type="button" class="am-pc-menu-btn" id="amPcBtnFitCanvas" title="Paskan Kanvas ke Layar">⊡ Fit</button>
        <button type="button" class="am-pc-menu-btn am-pc-menu-btn-export" id="amPcBtnExport" title="Ekspor Video MP4 (WebCodecs GPU Fast)">🎬 Export</button>
      </div>
    `;
    editorEl.insertBefore(menuBar, editorTop);

    // 2. Left Dock Panel (#amDesktopLeftDock) — Simplified 3 Tabs + Real APK Thumbnails
    const existingLeft = document.getElementById('amDesktopLeftDock');
    if (existingLeft) existingLeft.remove();

    const leftDock = document.createElement('aside');
    leftDock.id = 'amDesktopLeftDock';
    leftDock.innerHTML = `
      <div class="am-pc-dock-tabs" role="tablist">
        <button type="button" class="am-pc-dock-tab active" data-am-left-tab="effects">✨ Effects</button>
        <button type="button" class="am-pc-dock-tab" data-am-left-tab="layers">🗂 Layers & Media</button>
        <button type="button" class="am-pc-dock-tab" data-am-left-tab="presets">🔗 AM Link & Objek</button>
      </div>

      <!-- TAB 1: VISUAL APK THUMBNAIL EFFECTS BROWSER -->
      <div class="am-pc-dock-pane active" data-am-left-pane="effects">
        <div class="am-pc-search-row">
          <input type="search" class="am-pc-search-input" id="amPcEffectSearch" placeholder="Cari efek (Tiles, Blur, Bend, Spin, Shake)..." autocomplete="off">
          <button type="button" class="am-pc-menu-btn" id="amPcBtnExpandFxBrowser" title="Buka Browser Efek Layar Penuh">⤢</button>
        </div>
        <div class="am-pc-cat-strip" id="amPcEffectCats">
          <button type="button" class="am-pc-cat-pill active" data-cat="all">Semua</button>
          <button type="button" class="am-pc-cat-pill" data-cat="blur">Blur</button>
          <button type="button" class="am-pc-cat-pill" data-cat="warp">Distortion/Warp</button>
          <button type="button" class="am-pc-cat-pill" data-cat="color">Color & Light</button>
          <button type="button" class="am-pc-cat-pill" data-cat="transform">Move/Transform</button>
          <button type="button" class="am-pc-cat-pill" data-cat="repeat">Repeat</button>
          <button type="button" class="am-pc-cat-pill" data-cat="text">Text</button>
          <button type="button" class="am-pc-cat-pill" data-cat="drawing">Drawing/Edge</button>
          <button type="button" class="am-pc-cat-pill" data-cat="matte">Matte/Mask</button>
        </div>
        <div class="am-pc-fx-grid" id="amPcEffectList"></div>
      </div>

      <!-- TAB 2: LAYERS & MEDIA -->
      <div class="am-pc-dock-pane" data-am-left-pane="layers">
        <div class="am-pc-element-grid">
          <button type="button" class="am-pc-element-btn" id="amPcAddMediaBtn">🖼 + Video / Gambar</button>
          <button type="button" class="am-pc-element-btn" id="amPcAddAudioBtn">🎵 + Audio</button>
          <button type="button" class="am-pc-element-btn" data-am-quick-add="text">🔤 + Teks</button>
          <button type="button" class="am-pc-element-btn" data-am-quick-add="rect">▭ + Shape</button>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:4px;">
          <span style="font-size:11px;font-weight:700;color:var(--am-text-secondary);text-transform:uppercase;">Layer Aktif</span>
          <span id="amPcLayerCountBadge" style="font-size:10.5px;color:var(--am-accent-emerald);font-family:'JetBrains Mono',monospace;">0 Layer</span>
        </div>
        <div class="am-pc-layer-list" id="amPcLayerList"></div>
      </div>

      <!-- TAB 3: ALIGHT CREATIVE LINK IMPORTER & OBJECTS -->
      <div class="am-pc-dock-pane" data-am-left-pane="presets">
        <div class="am-pc-card">
          <h4><span>🔗 Impor Link Alight Creative</span></h4>
          <p>Tempel link <code>alightcreative.com/am/share/...</code> atau <code>alight.link/...</code></p>
          <input type="url" class="am-pc-search-input" id="amPcPresetUrlInput" placeholder="https://alight.link/... atau https://alightcreative.com/...">
          <select class="am-pc-search-input" id="amPcPresetModeSelect" style="cursor:pointer">
            <option value="auto">Otomatis (Direct Firebase ➔ Worker)</option>
            <option value="direct">Direct Firebase (.amproj ZIP)</option>
            <option value="worker_official">Cloudflare Worker (Official)</option>
            <option value="worker_premium">Cloudflare Worker (Premium)</option>
          </select>
          <button type="button" class="am-pc-btn-block primary" id="amPcBtnFetchPreset">🚀 Impor Proyek / Preset</button>
          <div id="amPcPresetStatus" style="font-size:11px;color:var(--am-text-secondary);line-height:1.4;">Siap mengimpor preset Alight Motion.</div>
        </div>

        <div class="am-pc-card">
          <h4>✨ Tambah Elemen Alight Motion</h4>
          <div class="am-pc-element-grid">
            <button type="button" class="am-pc-element-btn" data-am-quick-add="vector">✒ Vector Freehand</button>
            <button type="button" class="am-pc-element-btn" data-am-quick-add="circle">◯ Lingkaran</button>
            <button type="button" class="am-pc-element-btn" data-am-quick-add="star">★ Bintang</button>
            <button type="button" class="am-pc-element-btn" data-am-quick-add="null">🎯 Null Object</button>
            <button type="button" class="am-pc-element-btn" data-am-quick-add="camera">🎥 Kamera 3D</button>
            <button type="button" class="am-pc-element-btn" id="amPcOpenShapesDrawer">❖ Semua Shape</button>
          </div>
        </div>
      </div>
    `;

    let leftSplitter = document.getElementById('amDesktopLeftSplitter');
    if (!leftSplitter) {
      leftSplitter = document.createElement('div');
      leftSplitter.id = 'amDesktopLeftSplitter';
    }
    editorMain.insertBefore(leftDock, previewArea);
    editorMain.insertBefore(leftSplitter, previewArea);

    // 3. Right Dock Panel (#amDesktopRightDock) — Clean Alight Motion Inspector
    if (!document.getElementById('amDesktopRightDock')) {
      const rightSplitter = document.createElement('div');
      rightSplitter.id = 'amDesktopRightSplitter';

      const rightDock = document.createElement('aside');
      rightDock.id = 'amDesktopRightDock';
      rightDock.innerHTML = `
        <div class="am-pc-inspector-header">
          <div class="am-pc-inspector-title-row">
            <span id="amPcInspectorLayerTitle">INSPECTOR LAYER</span>
            <span id="amPcInspectorLayerType" style="font-size:10px;color:var(--am-accent-emerald);font-family:'JetBrains Mono',monospace;">KOMPOSISI</span>
          </div>
          <div class="am-pc-inspector-tabs" id="amPcInspectorTabs">
            <button type="button" class="am-pc-insp-btn active" data-insp="root">Ringkasan</button>
            <button type="button" class="am-pc-insp-btn" data-insp="move">Transform</button>
            <button type="button" class="am-pc-insp-btn" data-insp="effects">Effects</button>
            <button type="button" class="am-pc-insp-btn" data-insp="keys">Easing/KF</button>
            <button type="button" class="am-pc-insp-btn" data-insp="color">Color & Fill</button>
            <button type="button" class="am-pc-insp-btn" data-insp="blend">Blending</button>
            <button type="button" class="am-pc-insp-btn" data-insp="three">3D / Camera</button>
            <button type="button" class="am-pc-insp-btn" data-insp="hier">Parent/Mask</button>
          </div>
        </div>
        <div id="amDesktopRightDockBody"></div>
      `;

      editorMain.insertBefore(rightSplitter, hSplitter);
      editorMain.insertBefore(rightDock, hSplitter);
    }

    const rightBody = document.getElementById('amDesktopRightDockBody');
    if (rightBody && drawerEl && drawerEl.parentElement !== rightBody) {
      rightBody.appendChild(drawerEl);
    }

    // 4. Fullscreen Alight Motion Effect & Preset Picker Modal (#amPcEffectModalShade)
    if (!document.getElementById('amPcEffectModalShade')) {
      const modalShade = document.createElement('div');
      modalShade.id = 'amPcEffectModalShade';
      modalShade.className = 'hidden';
      modalShade.innerHTML = `
        <div class="am-pc-fx-modal" role="dialog" aria-modal="true" aria-label="Tambah Efek Alight Motion">
          <div class="am-pc-fx-modal-head">
            <div style="display:flex;align-items:center;gap:10px;">
              <span style="color:var(--am-accent-emerald);font-weight:700;font-size:14px;">✨ Pustaka Efek Alight Motion (APK Asli)</span>
              <input type="search" class="am-pc-search-input" id="amPcModalFxSearch" placeholder="Cari nama efek..." style="width:260px;">
            </div>
            <button type="button" class="am-pc-menu-btn" id="amPcModalFxClose">✕ Tutup</button>
          </div>
          <div class="am-pc-fx-modal-body">
            <div class="am-pc-fx-modal-catalog" id="amPcModalFxGrid"></div>
            <div class="am-pc-fx-modal-detail" id="amPcModalFxDetail">
              <div style="color:var(--am-text-secondary);font-size:12px;text-align:center;margin-top:40px;">
                Klik salah satu efek di sebelah kiri untuk melihat preview dan memilih <b>Standard Settings</b> atau <b>Preset Bawaan Alight Motion</b>.
              </div>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(modalShade);
    }

    // 5. Render Left Dock Visual Effects Browser (with Real APK .webp Thumbnails)
    let activeFxCat = 'all';
    let activeFxQuery = '';

    const FEATURED_AM_EFFECT_IDS = [
      'am_tile', 'am_dblur', 'am_gaussianblur', 'am_motionblur4', 'am_lensblur2',
      'am_oscillate3', 'am_swing2', 'am_wavewarp2', 'am_pinchbulge2', 'am_swirl4',
      'am_bend', 'am_turbulentdisplace', 'am_spin', 'am_autoshake', 'am_jitter',
      'am_echokf', 'am_linearrepeat', 'am_radialrepeat', 'am_exposure', 'am_glow',
      'am_rays2', 'am_chromakey', 'am_lumakey3', 'am_texttransform2', 'am_textprogress',
      'am_textspacing', 'am_drawingprogress'
    ];

    function getFilteredCatalog(query, cat) {
      const catalog = bridge.catalog() || [];
      const q = String(query || '').trim().toLowerCase();
      const filtered = catalog.filter((spec) => {
        const c = classifyEffectCategory(spec);
        if (cat !== 'all' && c !== cat) return false;
        if (!q) return true;
        const name = String(spec.name || '').toLowerCase();
        const amId = String(spec.amEffectId || spec.id || '').toLowerCase();
        return name.includes(q) || amId.includes(q);
      });
      return filtered.sort((a, b) => {
        const ia = FEATURED_AM_EFFECT_IDS.indexOf(a.id);
        const ib = FEATURED_AM_EFFECT_IDS.indexOf(b.id);
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        const aNative = a.amEffectId ? 1 : 0;
        const bNative = b.amEffectId ? 1 : 0;
        if (aNative !== bNative) return bNative - aNative;
        return 0;
      });
    }

    function renderEffectsBrowser() {
      const listEl = document.getElementById('amPcEffectList');
      if (!listEl) return;
      const filtered = getFilteredCatalog(activeFxQuery, activeFxCat);

      listEl.innerHTML = filtered.map((spec) => {
        const thumb = getThumbForSpec(spec);
        const presetCount = (spec.amPresets || []).length;
        return `
          <div role="button" tabindex="0" class="am-pc-fx-card" data-apply-fx="${escapeHtml(spec.id)}" title="${escapeHtml(spec.name)} — Klik untuk pasang ke layer">
            <div class="am-pc-fx-thumb-wrap">
              <img class="am-pc-fx-thumb-img" src="${escapeHtml(thumb)}" alt="${escapeHtml(spec.name)}" loading="lazy">
              ${presetCount > 0 ? `<span class="am-pc-fx-card-badge">${presetCount + 1} PRESET</span>` : ''}
            </div>
            <div class="am-pc-fx-card-body">
              <div class="am-pc-fx-card-title">${escapeHtml(spec.name || spec.id)}</div>
              <div class="am-pc-fx-card-sub">
                <span>${escapeHtml(spec.category || 'Efek')}</span>
                <span style="color:var(--am-accent-emerald);font-weight:700;">+ Pasang</span>
              </div>
            </div>
          </div>
        `;
      }).join('') || '<div style="grid-column:1/-1;padding:18px;color:var(--am-text-secondary);font-size:12px;text-align:center;">Tidak ada efek yang cocok.</div>';
    }

    function ensureTargetLayer() {
      let layer = bridge.selectedLayer();
      if (!layer && model.layers?.length) {
        bridge.select(model.layers[0].id);
        layer = bridge.selectedLayer();
      }
      if (!layer) {
        bridge.addLayer('shape', { shape: 'rect', name: 'Persegi 1' });
        layer = bridge.selectedLayer();
      }
      return layer;
    }

    function applyEffectToCurrentLayer(specId, preset = null) {
      const layer = ensureTargetLayer();
      if (!layer) return;
      const res = bridge.addEffect(layer, specId, preset);
      if (res && res.ok === false && res.reason) {
        try { window.toast?.(res.reason); } catch (_) { alert(res.reason); }
        return;
      }
      highlightInspectorTab('effects');
      syncInspectorHeader();
    }

    document.getElementById('amPcEffectSearch')?.addEventListener('input', (e) => {
      activeFxQuery = e.target.value || '';
      renderEffectsBrowser();
    });

    document.getElementById('amPcEffectCats')?.addEventListener('click', (e) => {
      const pill = e.target.closest('[data-cat]');
      if (!pill) return;
      activeFxCat = pill.getAttribute('data-cat') || 'all';
      document.querySelectorAll('#amPcEffectCats .am-pc-cat-pill').forEach((p) => p.classList.toggle('active', p === pill));
      renderEffectsBrowser();
    });

    document.getElementById('amPcEffectList')?.addEventListener('click', (e) => {
      const card = e.target.closest('[data-apply-fx]');
      if (!card) return;
      const specId = card.getAttribute('data-apply-fx');
      applyEffectToCurrentLayer(specId, null);
    });

    // 6. Fullscreen Alight Motion Effect Browser & Preset Picker Logic
    let modalQuery = '';
    function openEffectModal(initialSpecId = null) {
      const shade = document.getElementById('amPcEffectModalShade');
      if (!shade) return;
      shade.classList.remove('hidden');
      renderModalCatalog();
      const catalog = bridge.catalog() || [];
      const firstSpec = initialSpecId ? bridge.spec(initialSpecId) : catalog[0];
      if (firstSpec) renderModalDetail(firstSpec);
    }

    function closeEffectModal() {
      document.getElementById('amPcEffectModalShade')?.classList.add('hidden');
    }

    function renderModalCatalog() {
      const grid = document.getElementById('amPcModalFxGrid');
      if (!grid) return;
      const list = getFilteredCatalog(modalQuery, 'all');
      grid.innerHTML = list.map((spec) => {
        const thumb = getThumbForSpec(spec);
        const pCount = (spec.amPresets || []).length;
        return `
          <div role="button" tabindex="0" class="am-pc-fx-card" data-modal-fx="${escapeHtml(spec.id)}">
            <div class="am-pc-fx-thumb-wrap" style="height:88px;">
              <img class="am-pc-fx-thumb-img" src="${escapeHtml(thumb)}" alt="${escapeHtml(spec.name)}" loading="lazy">
              ${pCount > 0 ? `<span class="am-pc-fx-card-badge">${pCount + 1} PRESET</span>` : ''}
            </div>
            <div class="am-pc-fx-card-body">
              <div class="am-pc-fx-card-title">${escapeHtml(spec.name || spec.id)}</div>
              <div class="am-pc-fx-card-sub"><span>${escapeHtml(spec.category || 'Efek')}</span></div>
            </div>
          </div>
        `;
      }).join('');
    }

    function renderModalDetail(spec) {
      const detail = document.getElementById('amPcModalFxDetail');
      if (!detail || !spec) return;
      const meta = getMetaForSpec(spec);
      const thumb = getThumbForSpec(spec);
      const presets = spec.amPresets || [];
      const paramNames = (spec.params || []).slice(0, 8).map(p => p.label).join(', ');

      detail.innerHTML = `
        <img class="am-pc-fx-detail-preview" src="${escapeHtml(thumb)}" alt="${escapeHtml(spec.name)}">
        <div>
          <div style="font-size:15px;font-weight:700;color:var(--am-text-primary);">${escapeHtml(spec.name)}</div>
          <div style="font-size:11px;color:var(--am-accent-emerald);margin-top:2px;">${escapeHtml(spec.category || 'Efek Alight Motion')} · ${(spec.params || []).length} Parameter</div>
          ${meta?.desc ? `<p style="font-size:11.5px;color:var(--am-text-secondary);margin:8px 0 0 0;line-height:1.45;">${escapeHtml(meta.desc)}</p>` : ''}
        </div>
        <div style="font-size:11px;color:var(--am-text-secondary);">
          <b>Kontrol Parameter:</b> ${escapeHtml(paramNames || ' Default')}
        </div>
        <div style="font-size:11px;font-weight:700;color:var(--am-text-primary);text-transform:uppercase;letter-spacing:0.5px;margin-top:4px;">
          Pilih Pengaturan Awal / Preset:
        </div>
        <div class="am-pc-preset-pill-list">
          <button type="button" class="am-pc-preset-choice-btn primary" data-modal-apply-preset="-1">
            <span>Standard Settings</span>
            <span>＋ Pasang</span>
          </button>
          ${presets.map((p, idx) => `
            <button type="button" class="am-pc-preset-choice-btn" data-modal-apply-preset="${idx}">
              <span>✨ ${escapeHtml(p.title)}</span>
              <span>＋ Pasang</span>
            </button>
          `).join('')}
        </div>
      `;

      detail.querySelectorAll('[data-modal-apply-preset]').forEach((btn) => {
        btn.onclick = () => {
          const idx = parseInt(btn.getAttribute('data-modal-apply-preset'), 10);
          const chosenPreset = idx >= 0 && presets[idx] ? presets[idx] : null;
          applyEffectToCurrentLayer(spec.id, chosenPreset);
          closeEffectModal();
        };
      });
    }

    document.getElementById('amPcBtnOpenFxModal')?.addEventListener('click', () => openEffectModal());
    document.getElementById('amPcBtnExpandFxBrowser')?.addEventListener('click', () => openEffectModal());
    document.getElementById('amPcModalFxClose')?.addEventListener('click', closeEffectModal);
    document.getElementById('amPcEffectModalShade')?.addEventListener('click', (e) => {
      if (e.target.id === 'amPcEffectModalShade') closeEffectModal();
    });
    document.getElementById('amPcModalFxSearch')?.addEventListener('input', (e) => {
      modalQuery = e.target.value || '';
      renderModalCatalog();
    });
    document.getElementById('amPcModalFxGrid')?.addEventListener('click', (e) => {
      const card = e.target.closest('[data-modal-fx]');
      if (!card) return;
      const spec = bridge.spec(card.getAttribute('data-modal-fx'));
      if (spec) renderModalDetail(spec);
    });

    // 7. Wire Left Dock Tabs & Layer Bin
    const leftTabs = document.querySelectorAll('[data-am-left-tab]');
    const leftPanes = document.querySelectorAll('[data-am-left-pane]');
    leftTabs.forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-am-left-tab');
        leftTabs.forEach((b) => b.classList.toggle('active', b === btn));
        leftPanes.forEach((p) => p.classList.toggle('active', p.getAttribute('data-am-left-pane') === target));
        if (target === 'layers') renderLayerBin();
      });
    });

    function renderLayerBin() {
      const listEl = document.getElementById('amPcLayerList');
      const countBadge = document.getElementById('amPcLayerCountBadge');
      if (!listEl) return;
      const layers = Array.isArray(model.layers) ? model.layers : [];
      const selectedLayer = bridge.selectedLayer();
      if (countBadge) countBadge.textContent = `${layers.length} Layer`;

      if (!layers.length) {
        listEl.innerHTML = '<div style="padding:14px;color:var(--am-text-secondary);font-size:11.5px;text-align:center;">Belum ada layer. Tambahkan Shape, Teks, Media, atau Impor Link AM.</div>';
        return;
      }

      listEl.innerHTML = layers.map((l) => {
        const isSel = selectedLayer && selectedLayer.id === l.id;
        const fxCount = (l.effectStack || []).length;
        return `
          <div class="am-pc-layer-row ${isSel ? 'selected' : ''}" data-am-select-layer="${escapeHtml(l.id)}">
            <div class="am-pc-layer-row-left">
              <span class="am-pc-layer-type-tag">${escapeHtml(l.type || 'layer')}</span>
              <span style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px;">${escapeHtml(l.name || l.id)}</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;font-size:10px;color:var(--am-text-secondary);">
              ${fxCount ? `<span style="color:var(--am-accent-emerald);font-family:'JetBrains Mono',monospace;">${fxCount} FX</span>` : ''}
            </div>
          </div>
        `;
      }).join('');
    }

    document.getElementById('amPcLayerList')?.addEventListener('click', (e) => {
      const row = e.target.closest('[data-am-select-layer]');
      if (!row) return;
      const id = row.getAttribute('data-am-select-layer');
      bridge.select(id);
      renderLayerBin();
      syncInspectorHeader();
    });

    // 8. Wire Quick Element Adders & Preset Link Importer
    document.querySelectorAll('[data-am-quick-add]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const kind = btn.getAttribute('data-am-quick-add');
        if (kind === 'text') bridge.addLayer('text', { name: 'Teks Baru', text: 'Alight Motion' });
        else if (kind === 'null') bridge.addLayer('null', { name: 'Null 1' });
        else if (kind === 'camera') bridge.addLayer('camera', { name: 'Camera 1' });
        else if (kind === 'vector') bridge.addLayer('shape', { shape: 'vector', name: 'Vector 1' });
        else if (kind === 'circle') bridge.addLayer('shape', { shape: 'circle', name: 'Lingkaran 1' });
        else if (kind === 'star') bridge.addLayer('shape', { shape: 'star', name: 'Bintang 1' });
        else bridge.addLayer('shape', { shape: 'rect', name: 'Persegi 1' });
        renderLayerBin();
        syncInspectorHeader();
      });
    });

    document.getElementById('amPcAddMediaBtn')?.addEventListener('click', () => document.getElementById('mediaInput')?.click());
    document.getElementById('amPcAddAudioBtn')?.addEventListener('click', () => document.getElementById('audioInput')?.click());
    document.getElementById('amPcOpenShapesDrawer')?.addEventListener('click', () => ui.openAddPanel?.());

    async function handlePresetImport() {
      const urlInput = document.getElementById('amPcPresetUrlInput');
      const modeSelect = document.getElementById('amPcPresetModeSelect');
      const statusEl = document.getElementById('amPcPresetStatus');
      const rawUrl = String(urlInput?.value || '').trim();
      const mode = modeSelect?.value || 'auto';

      const setStatus = (msg, color = 'var(--am-text-secondary)') => {
        if (statusEl) {
          statusEl.style.color = color;
          statusEl.textContent = msg;
        }
      };

      const parsed = parseAlightShareUrl(rawUrl);
      if (!parsed) {
        setStatus('Masukkan tautan alightcreative.com atau alight.link terlebih dahulu.', 'var(--am-danger)');
        return;
      }

      try {
        if (mode === 'auto' || mode === 'direct') {
          setStatus('⏳ Mengunduh paket .amproj dari Alight Creative / Firebase...', 'var(--am-cyan-neon)');
          const resp = await fetch(`/api/am/direct-zip?url=${encodeURIComponent(rawUrl)}`);
          if (resp.ok) {
            const blob = await resp.blob();
            if (blob.size > 64) {
              const file = new File([blob], (parsed.pidClean || 'alight-preset') + '.zip', { type: 'application/zip' });
              setStatus(`✅ Paket diunduh (${(blob.size / 1024).toFixed(1)} KB). Mengimpor...`, 'var(--am-accent-emerald)');
              await ui.importProjectFile(file);
              setStatus(`🎉 Berhasil diimpor (${model.layers?.length || 0} layer)!`, 'var(--am-accent-emerald)');
              renderLayerBin();
              syncInspectorHeader();
              return;
            }
          }
        }
        setStatus('⏳ Mengimpor melalui jembatan Alight Creative...', 'var(--am-cyan-neon)');
        await bridge.importLink(rawUrl, mode === 'worker_premium' ? '2' : '1', (m) => setStatus(m, 'var(--am-cyan-neon)'));
        setStatus(`🎉 Preset berhasil diimpor (${model.layers?.length || 0} layer)!`, 'var(--am-accent-emerald)');
        renderLayerBin();
        syncInspectorHeader();
      } catch (err) {
        setStatus('Gagal mengimpor: ' + (err?.message || err), 'var(--am-danger)');
      }
    }

    document.getElementById('amPcBtnFetchPreset')?.addEventListener('click', handlePresetImport);

    // 9. Wire Top Bar Actions & Inspector Tabs
    document.getElementById('amPcBtnHome')?.addEventListener('click', () => ui.showHome?.());
    document.getElementById('amPcBtnProjectTitle')?.addEventListener('click', () => {
      const current = model.project?.name || 'Proyek Baru';
      const next = prompt('Nama Proyek:', current);
      if (next && next.trim() && model.project) {
        model.project.name = next.trim();
        ui.syncProject?.();
        syncInspectorHeader();
      }
    });
    document.getElementById('amPcBtnAspect')?.addEventListener('click', () => {
      if (!model.project) return;
      const isVertical = model.project.height > model.project.width;
      model.project.width = isVertical ? 1920 : 1080;
      model.project.height = isVertical ? 1080 : 1920;
      model.project.fps = 60;
      ui.syncProject?.();
      ui.fit?.();
      renderer.render?.();
      syncInspectorHeader();
    });
    document.getElementById('amPcBtnUndo')?.addEventListener('click', () => document.getElementById('undoBtn')?.click());
    document.getElementById('amPcBtnRedo')?.addEventListener('click', () => document.getElementById('redoBtn')?.click());
    document.getElementById('amPcBtnOpenLinkModal')?.addEventListener('click', () => {
      const linkUI = bridge.linkUI();
      if (linkUI?.openModal) linkUI.openModal();
      else document.querySelector('[data-am-left-tab="presets"]')?.click();
    });
    document.getElementById('amPcBtnImportXml')?.addEventListener('click', () => document.getElementById('xmlInput')?.click());
    document.getElementById('amPcBtnFitCanvas')?.addEventListener('click', () => ui.fit?.());
    document.getElementById('amPcBtnExport')?.addEventListener('click', () => document.getElementById('exportBtn')?.click());

    function highlightInspectorTab(mode) {
      document.querySelectorAll('#amPcInspectorTabs .am-pc-insp-btn').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-insp') === mode);
      });
    }

    document.getElementById('amPcInspectorTabs')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-insp]');
      if (!btn) return;
      const mode = btn.getAttribute('data-insp');
      ensureTargetLayer();
      highlightInspectorTab(mode);
      if (mode === 'root') ui.openInspectorRoot?.();
      else ui.openInspector?.(mode);
    });

    function syncInspectorHeader() {
      const titleEl = document.getElementById('amPcInspectorLayerTitle');
      const typeEl = document.getElementById('amPcInspectorLayerType');
      const compChip = document.getElementById('amPcCompChip');
      const projNameEl = document.getElementById('amPcProjectNameText');
      const sel = bridge.selectedLayer();

      if (titleEl) titleEl.textContent = sel ? (sel.name || sel.id) : 'KOMPOSISI PROYEK';
      if (typeEl) typeEl.textContent = sel ? String(sel.type || 'LAYER').toUpperCase() : 'SCENE';
      if (projNameEl && model.project?.name) projNameEl.textContent = model.project.name;
      if (compChip && model.project) {
        compChip.textContent = `${model.project.width || 1080}×${model.project.height || 1920} · ${model.project.fps || 60} FPS`;
      }
      if (drawerEl && drawerEl.classList.contains('hidden')) {
        ui.openInspectorRoot?.();
      }
    }

    // 10. Resizable Left, Right, and Bottom Timeline Splitters
    function bindSplitter(splitterId, varName, minVal, maxVal, isVertical, invertDelta = false) {
      const sp = document.getElementById(splitterId);
      if (!sp || sp.dataset.amBound) return;
      sp.dataset.amBound = '1';
      let dragging = false;
      let startPos = 0;
      let startSize = 0;

      sp.addEventListener('pointerdown', (e) => {
        if (window.innerWidth < 900) return;
        dragging = true;
        startPos = isVertical ? e.clientY : e.clientX;
        const currentRaw = getComputedStyle(document.documentElement).getPropertyValue(varName);
        startSize = parseFloat(currentRaw) || (isVertical ? 280 : 320);
        try { sp.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
      });

      window.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const delta = (isVertical ? e.clientY : e.clientX) - startPos;
        const next = Math.max(minVal, Math.min(maxVal, Math.round(startSize + (invertDelta ? -delta : delta))));
        document.documentElement.style.setProperty(varName, `${next}px`);
        ui.fit?.();
      });

      window.addEventListener('pointerup', () => {
        if (!dragging) return;
        dragging = false;
        ui.fit?.();
        renderer.resize?.();
        renderer.render?.();
      });
    }

    bindSplitter('amDesktopLeftSplitter', '--am-pc-left-w', 250, 500, false, false);
    bindSplitter('amDesktopRightSplitter', '--am-pc-right-w', 290, 520, false, true);
    bindSplitter('desktopHorizontalSplitter', '--am-pc-timeline-h', 180, 480, true, true);

    // Initial render
    renderEffectsBrowser();
    renderLayerBin();
    syncInspectorHeader();

    // Ensure a default layer is open in the Right Dock Inspector on startup
    if (drawerEl.classList.contains('hidden')) {
      ui.openInspectorRoot?.();
    }
    setTimeout(() => {
      ui.fit?.();
      renderer.render?.();
    }, 100);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDesktopStudio);
  } else {
    initDesktopStudio();
  }
})();
