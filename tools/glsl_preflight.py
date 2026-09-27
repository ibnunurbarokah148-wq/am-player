#!/usr/bin/env python3
"""
glsl_preflight.py — static sanity check for the generated ESSL 1.00 shaders.

No GL driver in this box, so we approximate what the compiler would reject:
  * unbalanced {} () []
  * identifiers that are declared nowhere (the #1 risk when re-implementing a prelude)
  * calls to functions that are neither user-defined nor GLSL ES 1.00 builtins
  * leftover ID.texture / ID.size  (texture substitution missed)
  * int uniform used arithmetically with a float literal  (no implicit conv)
  * float uniform used as a bare condition  (needs bool)
  * duplicate declarations

Exit code = number of errors (0 == all good).
"""
import os, re, sys, glob, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GLSL = os.path.join(ROOT, "webfx", "glsl")

KEYWORDS = set("""
void float int bool vec2 vec3 vec4 mat2 mat3 mat4 sampler2D
if else for while return break continue discard const uniform attribute varying
in out inout struct precision highp mediump lowp true false switch case default
do layout flat smooth
""".split())

BUILTIN_FUNCS = set("""
texture2D texture2DCv getTexSize
abs acos all and any asin atan ceil clamp compCos compSin cos cross
degrees dFdx dFdy distance dot equal exp exp2 faceforward floor fract
frexp fwidth greaterThan greaterThanEqual groupBarrier imageAtomicAdd
int isinf isnan length lessThan lessThanEqual log log10 log2 matCompMax
matCompMin max min mix mod not notEqual normalize or pow radians reflect
refract sign sin smoothstep sqrt step tan tanh texelFetch texelGather
texture texture2DProj textureCube transpose trunc uaddCarry unpackHalf2x16
umax umin umulExtended usubExtended
""".split())

BUILTIN_VARS = set("""
gl_FragColor gl_FragCoord gl_FragDepth gl_Position gl_PointSize
gl_FragData gl_Vertex gl_ModelViewProjectionMatrix
""".split())

DECL_KW = set("uniform attribute varying const".split())
TYPE_KW = set("""float int bool vec2 vec3 vec4 mat2 mat3 mat4 sampler2D
lowp mediump highp""".split())


def strip_noise(src):
    """remove comments, string literals, preprocessor lines (keeps #define names)"""
    src = re.sub(r"/\*.*?\*/", " ", src, flags=re.S)
    src = re.sub(r"//[^\n]*", " ", src)
    defines = set(re.findall(r"^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)", src, re.M))
    src = re.sub(r"^[^\S\n]*#.*$", " ", src, flags=re.M)      # preprocessor lines
    src = re.sub(r'"[^"]*"', '""', src)
    return src, defines


def collect_decls(src):
    """names that exist somewhere in the file (coarse — global scope assumed)"""
    names, funcs, dup = set(), set(), []
    # struct types + their members
    for m in re.finditer(r"\bstruct\s+([A-Za-z_]\w*)\s*\{([^}]*)\}", src, re.S):
        names.add(m.group(1))
        for mm in re.finditer(r"\b(?:float|int|bool|vec[234]|mat[234]|sampler2D)\s+([A-Za-z_]\w*)", m.group(2)):
            names.add(mm.group(1))
    # declarations: [precision] <type> a, b;
    for m in re.finditer(r"\b(uniform|attribute|varying|const)?\s*"
                         r"(?:lowp|mediump|highp)?\s*"
                         r"(?:float|int|bool|vec[234]|mat[234]|sampler2D|struct\s+[A-Za-z_]\w*)\s+"
                         r"([^;{}]+);", src):
        ids = re.findall(r"[A-Za-z_]\w*", m.group(2))
        ids = [i for i in ids if i not in TYPE_KW and not i.isdigit()]
        for i in ids:
            if i in names:
                dup.append(i)
            names.add(i)
    # function definitions & params
    for m in re.finditer(r"\b([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{", src):
        fname = m.group(1)
        if fname in KEYWORDS:
            continue
        funcs.add(fname); names.add(fname)
        for pm in re.finditer(r"\b(?:float|int|bool|vec[234]|mat[234]|sampler2D|struct\s+\w+)\s+([A-Za-z_]\w*)", m.group(2)):
            names.add(pm.group(1))
    # local variables inside blocks  (coarse: any `type name =` / `type name;`)
    for m in re.finditer(r"\b(?:float|int|bool|vec[234]|mat[234])\s+([A-Za-z_]\w*)\s*(?:=|,|;|\[)", src):
        names.add(m.group(1))
    # for(...) declarations
    for m in re.finditer(r"for\s*\(\s*(?:int|float)\s+([A-Za-z_]\w*)", src):
        names.add(m.group(1))
    return names, funcs, dup


def check_file(path):
    errs, warns = [], []
    raw = open(path, encoding="utf8").read()
    src, defines = strip_noise(raw)

    # 1. balance
    for o, c in (("{", "}"), ("(", ")"), ("[", "]")):
        if src.count(o) != src.count(c):
            errs.append("unbalanced %s%s: %d vs %d" % (o, c, src.count(o), src.count(c)))

    # 2. leftover texture member access
    for m in re.finditer(r"\b([A-Za-z_]\w*)\s*\.\s*(texture|size)\b", src):
        errs.append("leftover member access: %s.%s" % m.groups())

    names, funcs, dup = collect_decls(src)
    known = names | funcs | KEYWORDS | BUILTIN_FUNCS | BUILTIN_VARS | defines

    # 3. undeclared identifiers (skip swizzles / member access: token right after '.')
    undeclared = collections.Counter()
    for m in re.finditer(r"(?<!\.)\b([A-Za-z_]\w*)\b", src):
        tok = m.group(1)
        if tok in known or re.match(r"^\d", tok):
            continue
        undeclared[tok] += 1
    for t, n in undeclared.most_common():
        errs.append("undeclared identifier: %s (x%d)" % (t, n))

    # 4. calls to unknown function (skip `obj.method(`)
    for m in re.finditer(r"(?<!\.)\b([A-Za-z_]\w*)\s*\(", src):
        f = m.group(1)
        if f in KEYWORDS or f in BUILTIN_FUNCS or f in funcs or f in defines:
            continue
        if f in BUILTIN_VARS:
            continue
        errs.append("call to unknown function: %s()" % f)


    # 5. type discipline for the uniforms WE injected
    int_used_arith = set()
    for m in re.finditer(r"uniform\s+int\s+([A-Za-z_]\w*)", src):
        pid = m.group(1)
        for um in re.finditer(r"\b" + re.escape(pid) + r"\b\s*([*/+-])\s*-?\d+\.\d", src):
            int_used_arith.add(pid)
    for pid in sorted(int_used_arith):
        errs.append("int uniform used with float literal: %s" % pid)

    for m in re.finditer(r"uniform\s+float\s+([A-Za-z_]\w*)", src):
        pid = m.group(1)
        if re.search(r"(?:if|while|else\s+if)\s*\(\s*" + re.escape(pid) + r"\s*\)", src):
            errs.append("float uniform used as bare condition: %s" % pid)

    for pid in set(dup):
        warns.append("duplicate declaration: %s" % pid)

    return errs, warns


def main():
    files = sorted(glob.glob(os.path.join(GLSL, "*")))
    if not files:
        print("no shaders generated — run build_effects.py first"); return 1
    bad_files = 0
    err_total = collections.Counter()
    warn_total = 0
    detail = []
    for f in files:
        errs, warns = check_file(f)
        warn_total += len(warns)
        if errs:
            bad_files += 1
            detail.append((os.path.basename(f), errs))
            for e in errs:
                err_total[re.sub(r"\s*\(x\d+\)", "", e)] += 1

    print("files checked :", len(files))
    print("files with err:", bad_files, " (", len(files) - bad_files, "clean )")
    print("warnings      :", warn_total)
    print("\n== error histogram ==")
    for e, n in err_total.most_common(30):
        print("%5d  %s" % (n, e))
    if detail and "-v" in sys.argv:
        print("\n== per file ==")
        for f, errs in detail[:40]:
            print(f)
            for e in errs[:8]:
                print("   -", e)
    elif detail:
        print("\n(run with -v for per-file detail) first 15:")
        for f, errs in detail[:15]:
            print(" ", f, "->", errs[0], ("+%d more" % (len(errs) - 1)) if len(errs) > 1 else "")
    return bad_files


if __name__ == "__main__":
    sys.exit(0 if main() == 0 else 1)
