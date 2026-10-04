# Generator js/amraster.js — inti render dari js/app.js, tanpa UI.
# Dipakai ulang kalau app.js berubah: python3 /tmp/opencode/gen_amraster2.py
import re

src = open('js/app.js', encoding='utf-8').read().split('\n')

def sl(a, b):  # baris 1-indexed inklusif
    return '\n'.join(src[a - 1:b])

assert src[184].strip() == '}', 'penanda drawDrawing berubah'
assert src[185].startswith('const _drawWork'), 'penanda _drawWork berubah'

body = '\n\n'.join([
    sl(11, 12),                                                   # clamp, lerp
    sl(71, 79),                                                   # ensureDrawImage
    re.sub(r'\b_drawWork\b', '_dw()', sl(80, 185)),               # drawDrawing (+ kurung tutup)
    "let _drawWork=null;\nfunction _dw(){ return _drawWork||(_drawWork={ _cv:document.createElement('canvas'), _tmp:document.createElement('canvas'),\n"
    "  get _cx(){ return this._cv.getContext('2d') }, get _tx(){ return this._tmp.getContext('2d') } }) }",
    sl(514, 574),                                                 # hydratePresetMedia + buildWaveform
    sl(767, 814),                                                 # evalProp, easeOf
    sl(817, 882),                                                 # renderAt, GL, blitGL, renderAtAsync, warmGL
    sl(884, 922)                                                  # _rastCv + rasterContent
        .replace("const _rastCv=document.createElement('canvas');", "let _rastCv=null;")
        .replace("if(_rastCv.width!==Wc||_rastCv.height!==Hc)",
                 "if(!_rastCv) _rastCv=document.createElement('canvas');\n  if(_rastCv.width!==Wc||_rastCv.height!==Hc)"),
    sl(930, 968),                                                 # activeCameraAt, applyCameraTransform, render2D
    sl(970, 1063),                                                # drawCompositeFxLayer, drawLayer, blendMap
    sl(1072, 1321),                                               # layerVel..drawMedia
])

body = body.replace('offComp', "_cv('comp')").replace('offLayer', "_cv('layer')")
n = (body.count('S.active'), body.count('S.T'), body.count('S.playing'))
body = body.replace('S.active', 'PROJ').replace('S.playing', 'PLAYING').replace('S.T', 'TIME')
body = body.replace('renderLayerBar(); ', '').replace('renderFrame()', 'onRefresh()')
body = body.replace(
    "window.__gl = GL; // debug: status engine GL (useGL/fail/busy/pending)\nwindow.__amgldbg = AMGL.dbg;",
    "if(typeof window!=='undefined'){ window.__gl = GL; window.__amgldbg = AMGL.dbg; }")

# TIME = waktu yang sedang dirender (dipakai argumen default drawLayer/drawMedia)
a1 = "  const P=PROJ;\n  if(!P||!targetCanvas) return;\n  if(GL.useGL && !GL.fail){\n    if(GL.busy)"
a2 = "  const P=PROJ;\n  if(!P||!targetCanvas) return;\n  if(GL.useGL && !GL.fail){\n    try{"
assert body.count(a1) == 1 and body.count(a2) == 1, 'blok renderAt tidak unique'
body = body.replace(a1, "  const P=PROJ;\n  if(!P||!targetCanvas) return;\n  TIME=time;\n" + a1.split('\n', 1)[1])
body = body.replace(a2, "  const P=PROJ;\n  if(!P||!targetCanvas) return;\n  TIME=time;\n" + a2.split('\n', 1)[1])
assert body.count('TIME=time;') == 2

# export semua deklarasi top-level (kolom 0, di luar blok -> asumsi app.js rapi)
body = re.sub(r'^(?:async )?(?:function|const|let|var) [A-Za-z_$]',
              lambda m: 'export ' + m.group(0), body, flags=re.M)

# tolak export yang masuk ke dalam blok (kedalaman kurawal > 0)
lines, depth, bad = body.split('\n'), 0, []
for i, l in enumerate(lines):
    if l.startswith('export ') and depth > 0:
        bad.append((i + 1, l[:60]))
    depth += l.count('{') - l.count('}')
if bad:
    print('EXPORT NESTED:', bad[:5])
    raise SystemExit(1)

header = """/* amraster.js — INTI RENDER mesin motionary, tanpa satu pun elemen UI.
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

"""

out = header + body + '\n'
open('js/amraster.js', 'w', encoding='utf-8').write(out)
print(f'amraster.js: {len(out.splitlines())} baris · S.active x{n[0]} S.T x{n[1]} S.playing x{n[2]} diganti')
