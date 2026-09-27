#!/usr/bin/env python3
"""
build_effects.py — convert Alight Motion effect XML defs into a web-ready bundle.

Reads : apk-analysis/Alight motion /assets/effects/*.xml   (source of truth)
        reference/effects_catalog_v5.json                  (param/shader ground truth)
        reference/effects_catalog.json                     (human display names)
Writes: webfx/effects.json           metadata + params (no GLSL)
        webfx/glsl/<file>.<g>.<type> preprocessed shader source
        copies thumb/ resource/ textures/ presets/ under webfx/effects/

Pipeline per shader:
  1. strip the effect's own uniform/param ids out of the source -> replaced by our
     declared uniforms (see emit_prelude).
  2. texture params:  ID.texture -> ID   |   ID.size -> __sz_ID
     (declares `uniform sampler2D ID; uniform vec2 __sz_ID;`)
  3. numeric params become float; integer comparisons `ID == 3` are rewritten to
     `ID == 3.0` because GLSL ES 1.00 has no implicit int->float conversion.
  4. inject the AM prelude (acScreenNorm / texture2DCv / getTexSize / acPass ...).

Validation: every built effect is cross-checked against effects_catalog_v5.json
(param id set + widget kinds + shader groups). Mismatches are printed.
"""
import json, os, re, sys, glob, html, shutil
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FX   = os.path.join(ROOT, "apk-analysis", "Alight motion ", "assets", "effects")
OUT  = os.path.join(ROOT, "webfx")
CAT_V5  = os.path.join(ROOT, "reference", "effects_catalog_v5.json")
CAT_OLD = os.path.join(ROOT, "reference", "effects_catalog.json")

# ---------------------------------------------------------------- string table
# res/values/strings.xml is gone from the tree, but the compiled table survived
# in resources.arsc — tools/arsc_strings.py flattens it to reference/app_strings.json
STRINGS_JSON = os.path.join(ROOT, "reference", "app_strings.json")

def load_strings():
    if not os.path.exists(STRINGS_JSON):
        print("!! reference/app_strings.json tidak ada — jalankan tools/arsc_strings.py",
              file=sys.stderr)
        return {}
    try:
        with open(STRINGS_JSON, encoding="utf8") as f:
            return json.load(f)
    except Exception as e:
        print("!! app_strings.json gagal dibaca:", e, file=sys.stderr)
        return {}

STR = load_strings()

# ---------------------------------------------------------------- thumbnails
# APK ships thumbs as snake_case .webp (thumb/box_blur.webp) while the XML
# attributes point at camel/compact names (thumb/boxblur.webp) — index by a
# normalised key and fall back through several candidates.
def _norm(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())

def _build_thumb_index():
    idx, raw = {}, {}
    d = os.path.join(FX, "thumb")
    if not os.path.isdir(d):
        return idx, raw
    for f in os.listdir(d):
        base, ext = os.path.splitext(f)
        if ext.lower() not in (".webp", ".png", ".jpg", ".jpeg"):
            continue
        raw[os.path.join("thumb", f)] = os.path.join("thumb", f)
        key = _norm(base[:-3] if base.endswith("_bg") else base)
        if base.endswith("_bg"):
            idx.setdefault(key + "__bg", f)          # background variant kept aside
        else:
            idx.setdefault(key, f)
    return idx, raw

THUMB_IDX, THUMB_RAW = _build_thumb_index()

def resolve_thumb(fname, eid, attr):
    # 1) exact path straight out of the XML attribute
    if attr:
        rel = attr if attr.startswith("thumb/") else "thumb/" + os.path.basename(attr)
        full = os.path.join(FX, rel)
        if os.path.exists(full):
            return "effects/" + rel
        b = os.path.splitext(os.path.basename(attr))[0]
        for ext in (".webp", ".png", ".jpg", ".jpeg"):
            if os.path.exists(os.path.join(FX, "thumb", b + ext)):
                return "effects/thumb/" + b + ext
    # 2) normalised candidates: attr, file name, effect id, minus trailing digits
    cands = []
    if attr:
        cands.append(os.path.splitext(os.path.basename(attr))[0])
    cands += [fname, _norm(fname)]
    if eid:
        tail = eid.split(".")[-1]
        cands += [tail, _norm(tail)]
    seen = set()
    for c in cands:
        for k in (c, re.sub(r"\d+$", "", c or "")):
            n = _norm(k)
            if not n or n in seen:
                continue
            seen.add(n)
            if n in THUMB_IDX:
                return "effects/thumb/" + THUMB_IDX[n]
            if (n + "__bg") in THUMB_IDX:
                return "effects/thumb/" + THUMB_IDX[n + "__bg"]
    return None

def resolve(ref, local=None, fallback=""):
    """@am:string/foo | @string/foo | literal -> human string"""
    if ref is None:
        return fallback
    if local and ref in local:
        return local[ref]
    if ref.startswith("@"):
        m = re.match(r"@(?:[A-Za-z0-9_]+:)?string/([A-Za-z0-9_.]+)$", ref)
        if m and m.group(1) in STR:
            return STR[m.group(1)]
        # last resort: basename of the ref
        m = re.match(r"@(?:[A-Za-z0-9_]+:)?string/([A-Za-z0-9_.]+)$", ref)
        return m.group(1) if m else fallback
    return ref

# ---------------------------------------------------------------- prelude
FRAG_PRELUDE = """\
precision {prec} float;
precision {prec} int;

varying vec2 acScreenNorm;   /* uv, y-up (GL convention) — AM: normalized screen coord */
#define   acLayerNorm        acScreenNorm

uniform vec2  acScreenSize;       /* render target px */
uniform vec2  acLayerSize;        /* layer px */
uniform vec2  acLayerCenter;      /* layer center px */
uniform vec2  acLayerCenterNorm;  /* layer center, normalized */
uniform vec2  acLayerPivot;       /* pivot offset px */
uniform vec2  acLayerSizeNorm;    /* layer size / screen size */
uniform vec2  acPreviewSize;      /* preview canvas px */
uniform vec2  acProjectSize;      /* project px */
uniform vec2  acVelocity;         /* per-frame translation */
uniform float acTime;             /* seconds */
uniform float acAngularVelocity;
uniform float acScaleVelocity;
uniform mat3  acScreenToLayer;
uniform mat3  acLayerToScreen;
uniform mat4  acLTS;
uniform bool  acShowGuides;
uniform int   acPass;

vec4  texture2DCv(sampler2D s, vec2 uv) {{ return texture2D(s, uv); }}
vec2  getTexSize(vec2 sz)             {{ return sz; }}
float saturate(float v)               {{ return clamp(v, 0.0, 1.0); }}
vec2  saturate(vec2 v)                {{ return clamp(v, 0.0, 1.0); }}
vec3  saturate(vec3 v)                {{ return clamp(v, 0.0, 1.0); }}
vec4  saturate(vec4 v)                {{ return clamp(v, 0.0, 1.0); }}

"""

VERT_PRELUDE = """\
precision {prec} float;
precision {prec} int;

attribute vec4 acPos;
attribute vec2 acTexcoord;

varying vec2 acScreenNorm;

uniform vec2 acScreenSize;
uniform vec2 acLayerSize;

void vertShaderInit(void) {{
    gl_Position  = acPos;
    acScreenNorm = acTexcoord;
}}

"""

DEFAULT_VERT = """\
precision {prec} float;
precision {prec} int;

attribute vec4 acPos;
attribute vec2 acTexcoord;
varying   vec2 acScreenNorm;

void main(void) {{
    gl_Position  = acPos;
    acScreenNorm = acTexcoord;
}}
"""

# identifiers that exist only as locals / builtins and must never be turned into uniforms
BUILTIN_FUNCS = set("""
texture2D texture2DCv getTexSize gl_FragColor gl_FragCoord gl_Position
abs acos asin atan ceil clamp cos cross degrees distance dot exp exp2
faceforward floor fract frexp isinf isnan length log log10 log2
max min mix mod normalize pow radians reflect refract sign sin sqrt
step tan tanh trunc dFdx dFdy fwidth any all notEqual equal lessThan
greaterThan lessThanEqual greaterThanEqual not
""".split())

GLSL_KEYWORDS = set("""
void main float int bool vec2 vec3 vec4 mat2 mat3 mat4 sampler2D
if else for while return break continue discard const uniform attribute varying
in out inout layout struct precision highp mediump lowp true false
switch case default do
""".split())


# ---------------------------------------------------------------- param parsing
def parse_color(val, alpha=True):
    v = (val or "").lstrip("#")
    if len(v) == 3:
        v = "".join(c * 2 for c in v)
        v += "FF"
    elif len(v) == 6:
        v += "FF"
    elif len(v) == 8:
        pass
    else:
        v = "FFFFFFFF"
    try:
        r, g, b, a = (int(v[i:i + 2], 16) / 255.0 for i in (0, 2, 4, 6))
    except ValueError:
        r = g = b = 0.0; a = 1.0
    if not alpha:
        a = 1.0
    return [round(r, 5), round(g, 5), round(b, 5), round(a, 5)]

def parse_point(val):
    if not val:
        return [0.0, 0.0]
    parts = re.split(r"[,\s]+", val.strip())
    try:
        return [float(parts[0]), float(parts[1]) if len(parts) > 1 else 0.0]
    except ValueError:
        return [0.0, 0.0]

def parse_vec(val, n, fill=0.0):
    """parse '0.,100.,600.' / '0,1,0' / missing -> [n floats]"""
    if not val:
        return [fill] * n
    parts = [p for p in re.split(r"[,\s]+", val.strip()) if p]
    out = []
    for i in range(n):
        try:
            out.append(float(parts[i]) if i < len(parts) else fill)
        except ValueError:
            out.append(fill)
    return out

MAT4_IDENTITY = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]

def parse_num(val, default=0.0):
    try:
        return float(val)
    except (TypeError, ValueError):
        return default

NUMERIC = {"spinner", "slider", "selector", "point", "float"}
VEC_KINDS = {"point": ("vec2", 2), "xyz": ("vec3", 3), "hue-disc": ("vec3", 3),
             "color": ("vec4", 4), "orient": ("mat4", 16)}
def local_strings(root):
    out = {}
    for loc in root.iter("locale"):
        if (loc.get("lang") or "en") != "en":
            continue
        for s in loc.iter("string"):
            out[s.get("name")] = "".join(s.itertext()).strip()
    return out

def parse_params(root, loc):
    """returns list of param dicts + dict id->kind"""
    params, kinds = [], {}
    pnode = None
    for child in root:
        if child.tag == "params":
            pnode = child
            break
    if pnode is None:
        return params, kinds

    for el in pnode:
        tag = el.tag
        if tag in ("section", "strings"):
            continue
        pid = el.get("id")
        if not pid:
            continue
        p = {"id": pid, "kind": tag}
        p["label"] = resolve(el.get("label"), loc, fallback=pid)
        if tag == "texture":
            p["srcType"] = el.get("srcType", "content")
            p["src"] = el.get("src")
        elif tag in ("spinner", "slider"):
            p["default"] = parse_num(el.get("default"))
            p["min"] = parse_num(el.get("min"), -1e9)
            p["max"] = parse_num(el.get("max"), 1e9)
            p["step"] = parse_num(el.get("step"), 0.01)
            if el.get("type"):
                p["ui"] = el.get("type")
            if el.get("logscale"):
                p["logscale"] = parse_num(el.get("logscale"))
        elif tag == "selector":
            p["default"] = parse_num(el.get("default"))
            p["choices"] = [
                {"label": resolve(c.get("label"), loc, fallback=c.get("label", "")),
                 "value": parse_num(c.get("value"))}
                for c in el.findall("choice")
            ]
        elif tag == "switch":
            p["default"] = (el.get("default") or "false").lower() in ("true", "1", "yes")
        elif tag == "color":
            p["default"] = parse_color(el.get("default"), alpha=(el.get("alpha") != "false"))
        elif tag == "point":
            p["default"] = parse_point(el.get("default"))
        elif tag == "xyz":
            p["default"] = parse_vec(el.get("default"), 3)
            if el.get("type"):
                p["ui"] = el.get("type")
        elif tag == "hue-disc":
            p["default"] = parse_vec(el.get("default"), 3, fill=0.5)
        elif tag == "orient":
            p["default"] = list(MAT4_IDENTITY)
            p["invert"] = el.get("invert") == "true"
        elif tag == "float":
            p["default"] = parse_num(el.get("value"), parse_num(el.get("default")))
            p["readonly"] = True
        elif tag == "tip":
            p["default"] = el.get("text") or ""
        else:                                   # string / effect / unknown
            p["default"] = el.get("default") or ""
        params.append(p)
        kinds[pid] = tag
    return params, kinds


# ---------------------------------------------------------------- GLSL rewriting
def classify_numeric(src, pid, kind):
    """float (safe default) vs int — only int when it's *never* used arithmetically."""
    if kind not in NUMERIC:
        return None
    esc = re.escape(pid)
    # explicit int() cast => definitely a float in AM
    if re.search(r"\bint\s*\(\s*" + esc + r"\b", src):
        return "float"
    # used as operand with a float literal / float function => float
    if re.search(esc + r"\s*[*/+-]", src) and re.search(esc + r"[^;]*\d+\.", src):
        return "float"
    if re.search(r"\b(pow|mix|clamp|length|distance|smoothstep|step|abs|sin|cos|"
                 r"max|min|mod|floor|fract|sqrt|dot|normalize)\s*\([^;]*\b" + esc + r"\b", src):
        return "float"
    # bare comparisons against integer literals, and nothing else => int
    cmp_only = True
    for m in re.finditer(r"\b" + esc + r"\b", src):
        tail = src[m.end():m.end() + 12]
        if not re.match(r"\s*(==|!=|<=|>=|<|>)", tail):
            cmp_only = False
            break
    return "int" if cmp_only else "float"


def rewrite_int_literals(src, pids):
    """ID == 3  ->  ID == 3.0   (only for ids we declared as float)"""
    out = src
    for pid in pids:
        esc = re.escape(pid)
        out = re.sub(
            r"(\b" + esc + r"\b\s*(?:==|!=|<=|>=|<|>)\s*)(-?\d+)(?![.\d])",
            lambda m: m.group(1) + m.group(2) + ".0",
            out)
    return out


def subst_textures(src, tex_ids):
    """ID.texture -> ID     ID.size -> __sz_ID"""
    for tid in tex_ids:
        esc = re.escape(tid)
        src = re.sub(r"\b" + esc + r"\s*\.\s*texture\b", tid, src)
        src = re.sub(r"\b" + esc + r"\s*\.\s*size\b", "__sz_" + tid, src)
    return src


def sniff_ids(src):
    """identifiers used in a shader body (rough)"""
    return set(re.findall(r"\b([A-Za-z_][A-Za-z0-9_]*)\b", re.sub(r'"[^"]*"', "", src)))


# ---------------------------------------------------------------- effect build
def build_effect(path, glsl_dir):
    fname = os.path.basename(path)[:-4]
    try:
        root = ET.parse(path).getroot()
    except Exception as e:
        print("!! parse fail", path, e, file=sys.stderr)
        return None
    if root.tag != "effect":
        return None

    loc = local_strings(root)
    params, kinds = parse_params(root, loc)
    tex_ids = [p["id"] for p in params if p["kind"] == "texture"]

    # --- passes -------------------------------------------------------
    passes = []
    iters = None
    for child in root:
        if child.tag == "passes":
            for ps in child.findall("pass"):
                passes.append({
                    "target": ps.get("target"),
                    "effect": ps.get("effect"),
                    "src":    ps.get("src"),
                    "blend":  ps.get("blend"),
                })
        elif child.tag == "iterations":
            iters = child.get("param")
    if not passes:
        passes = [{}]

    # --- shaders ------------------------------------------------------
    shaders = []
    for sh in root.iter("shader"):
        body = sh.text or ""
        typ = sh.get("type", "fragment")
        grp = sh.get("group", "0")
        prec = "highp" if sh.get("precision") == "high" else "highp"
        shaders.append({"type": typ, "group": grp, "precision": prec, "raw": body})

    if not shaders:
        native = True            # 46 effects are pure param logic (fade, flicker,
        shaders = []             # repeat-*, text-*) — no GLSL, app-side implementation)
    else:
        native = False

    # --- static textures (srcType="image"): XML says .png, APK ships .webp -----
    for p in params:
        if p["kind"] != "texture" or p.get("srcType") != "image" or not p.get("src"):
            continue
        rel = p["src"]
        cand = os.path.join(FX, rel)
        if not os.path.exists(cand):
            base, ext = os.path.splitext(rel)
            for alt in (".webp", ".png", ".jpg", ".jpeg"):
                if os.path.exists(os.path.join(FX, base + alt)):
                    cand = os.path.join(FX, base + alt); break
        if os.path.exists(cand):
            p["asset"] = "effects/" + os.path.relpath(cand, FX)

    # --- emit GLSL ----------------------------------------------------
    # numeric type inference, done once against the whole raw source
    allraw = "\n".join(s["raw"] for s in shaders)
    decl = {}                                   # id -> glsl decl line
    float_ids, int_ids, bool_ids = [], [], []
    for p in params:
        pid, kind = p["id"], p["kind"]
        if kind == "texture":
            decl[pid] = ("tex", "uniform sampler2D %s; uniform vec2 __sz_%s;" % (pid, pid))
        elif kind in VEC_KINDS and kind != "point":
            glsl_t = VEC_KINDS[kind][0]
            decl[pid] = (glsl_t, "uniform %s %s;" % (glsl_t, pid))
            float_ids.append(pid)
        elif kind == "point":
            decl[pid] = ("vec2", "uniform vec2 %s;" % pid); float_ids.append(pid)
        elif kind == "switch":
            bare = bool(re.search(r"(?:if\s*\(\s*|!\s*|\belse\s+if\s*\(\s*)" + re.escape(pid) + r"\s*\)", allraw))
            if bare:
                decl[pid] = ("bool", "uniform bool %s;" % pid); bool_ids.append(pid)
            else:
                decl[pid] = ("float", "uniform float %s;" % pid); float_ids.append(pid)
        else:
            t = classify_numeric(allraw, pid, kind) or "float"
            decl[pid] = (t, "uniform %s %s;" % (t, pid))
            (int_ids if t == "int" else float_ids).append(pid)

    float_param_lines = [decl[i][1] for i in float_ids if i in decl]

    files = []
    for s in shaders:
        body = s["raw"]
        body = subst_textures(body, tex_ids)
        body = rewrite_int_literals(body, float_ids)
        # drop only the uniform decls whose NAME we already declared (duplicate
        # declaration = link error). anything else the author wrote is kept.
        ours = set(decl)
        def _drop(m):
            names = re.findall(r"[A-Za-z_][A-Za-z0-9_]*", m.group(0).split(";", 1)[0])
            names = [n for n in names if n != "uniform" and n not in
                     ("float", "int", "bool", "vec2", "vec3", "vec4", "mat2", "mat3",
                      "mat4", "sampler2D", "lowp", "mediump", "highp", "const")]
            return "" if any(n in ours for n in names) else m.group(0)
        body = re.sub(r"^[ \t]*uniform\s+[^;]+;", _drop, body, flags=re.M)

        pre = (VERT_PRELUDE if s["type"] == "vertex" else FRAG_PRELUDE).format(prec=s["precision"])
        code = pre + "\n" + "\n".join(decl[k][1] for k in decl) + "\n\n" + body

        out = os.path.join(glsl_dir, "%s.%s.%s" % (fname, s["group"], s["type"]))
        with open(out, "w", encoding="utf8") as f:
            f.write(code)
        files.append({"type": s["type"], "group": int(s["group"]) if s["group"].isdigit() else s["group"],
                      "src": "glsl/%s.%s.%s" % (fname, s["group"], s["type"])})

    # --- meta ---------------------------------------------------------
    name = resolve(root.get("name"), loc, fallback=fname.replace("-", " ").title())
    desc = resolve(root.get("desc"), loc, fallback="")
    thumb = resolve_thumb(fname, root.get("id"), root.get("thumb"))
    meta = {
        "file":     fname,
        "id":       root.get("id"),
        "type":     "native" if native else "shader",
        "name":     name,
        "desc":     desc,
        "category": root.get("category") or "other",
        "tags":     [t.strip() for t in (root.get("tags") or "").split(",") if t.strip()],
        "thumb":    thumb,
        "deprecated": root.get("deprecated") == "true",
        "experimental": root.get("experimental") == "true" or any(
            f["type"] == "vertex" for f in files),
        "params":   params,
        "passes":   passes,
        "iterations": iters,
        "shaders":  files,
    }
    return meta


def copy_assets():
    """thumbs / static textures / presets live next to the effect XMLs.
    Idempotent: skip when the destination already has the same file count —
    this box has nasty filesystem stalls, re-copying 368 webp every build hurts.
    """
    copied = {}
    for sub in ("thumb", "resource", "textures", "presets"):
        src = os.path.join(FX, sub)
        dst = os.path.join(OUT, "effects", sub)
        if not os.path.isdir(src):
            continue
        n_src = sum(len(f) for _, _, f in os.walk(src))
        if os.path.isdir(dst):
            n_dst = sum(len(f) for _, _, f in os.walk(dst))
            if n_dst == n_src:
                copied[sub] = "%d (cached)" % n_dst
                continue
            shutil.rmtree(dst)
        shutil.copytree(src, dst)
        copied[sub] = sum(len(f) for _, _, f in os.walk(dst))
    return copied


def validate(effects):
    """cross-check every built effect against reference/effects_catalog_v5.json.

    The catalog's generator also emitted `<string name=...>` and `<iterations>`
    as if they were params — those ids are filtered so real drift shows up.
    """
    CATALOG_NOISE = {"name", "desc", "iterations"}
    if not os.path.exists(CAT_V5):
        return ("skip", "effects_catalog_v5.json tidak ada")
    cat = json.load(open(CAT_V5, encoding="utf8"))
    built = {e["id"]: e for e in effects if e.get("id")}
    miss_param, widget_diff, no_cat, no_build = [], [], [], []
    matched = 0
    for eid, e in built.items():
        c = cat.get(eid)
        if not c:
            no_cat.append(e["file"]); continue
        matched += 1
        cids = {p["id"]: p.get("widget") for p in (c.get("parameters") or [])
                if p.get("id") and p.get("id") not in CATALOG_NOISE}
        bids = {p["id"]: p["kind"] for p in e["params"]}
        gone = set(cids) - set(bids)
        if gone:
            miss_param.append((e["file"], sorted(gone)))
        for pid, w in cids.items():
            if pid in bids and bids[pid] != w:
                widget_diff.append((e["file"], pid, w, bids[pid]))
    for eid in cat:
        if eid not in built:
            no_build.append(cat[eid].get("file", eid))
    ok = not miss_param and not widget_diff
    return ("ok" if ok else "DIFF", {
        "catalog": len(cat), "built": len(built), "matched": matched,
        "param_missing": miss_param, "widget_diff": widget_diff,
        "built_not_in_catalog": no_cat, "catalog_not_built": len(no_build),
    })


def main():
    glsl_dir = os.path.join(OUT, "glsl")
    os.makedirs(glsl_dir, exist_ok=True)
    for f in glob.glob(os.path.join(glsl_dir, "*")):
        os.remove(f)

    # default fullscreen vertex shader (used by the ~246 effects without one)
    with open(os.path.join(glsl_dir, "__default.vert"), "w", encoding="utf8") as f:
        f.write(DEFAULT_VERT.format(prec="highp"))

    effects = []
    for path in sorted(glob.glob(os.path.join(FX, "*.xml"))):
        m = build_effect(path, glsl_dir)
        if m:
            effects.append(m)

    index = {e["id"]: e["file"] for e in effects if e["id"]}
    bundle = {
        "version": 2,
        "count": len(effects),
        "shader": sum(1 for e in effects if e["type"] == "shader"),
        "native": sum(1 for e in effects if e["type"] == "native"),
        "byId": index,
        "effects": effects,
    }
    with open(os.path.join(OUT, "effects.json"), "w", encoding="utf8") as f:
        json.dump(bundle, f, ensure_ascii=False, separators=(",", ":"))

    assets = copy_assets()
    status, info = validate(effects)

    cats = {}
    nparam = nsh = nlabel = 0
    for e in effects:
        cats[e["category"]] = cats.get(e["category"], 0) + 1
        nparam += len(e["params"])
        nsh += len(e["shaders"])
        if e["name"] and not e["name"].startswith("effect_"):
            nlabel += 1
    print("source    :", FX)
    print("effects   :", len(effects), " (shader %d / native %d)" %
          (bundle["shader"], bundle["native"]))
    print("shaders   :", nsh, "->", glsl_dir)
    print("params    :", nparam)
    print("labels    : %d/%d effect punya nama layak (%d string resource)" %
          (nlabel, len(effects), len(STR)))
    print("assets    :", assets)
    print("categories:", json.dumps(cats, sort_keys=True))
    print("size      :", os.path.getsize(os.path.join(OUT, "effects.json")) // 1024, "KB")
    print()
    print("== VALIDATION vs effects_catalog_v5.json :", status)
    if isinstance(info, dict):
        print("   catalog=%d built=%d matched=%d  catalog_not_built=%d" %
              (info["catalog"], info["built"], info["matched"], info["catalog_not_built"]))
        if info["param_missing"]:
            print("   !! param hilang (%d):" % len(info["param_missing"]))
            for f, ps in info["param_missing"][:20]:
                print("      -", f, ps)
        if info["widget_diff"]:
            print("   !! widget beda (%d):" % len(info["widget_diff"]))
            for f, pid, w, k in info["widget_diff"][:20]:
                print("      -", f, pid, "catalog=%s built=%s" % (w, k))
        if info["built_not_in_catalog"]:
            print("   ~ built tanpa catalog:", info["built_not_in_catalog"][:10])
    else:
        print("  ", info)


if __name__ == "__main__":
    main()
