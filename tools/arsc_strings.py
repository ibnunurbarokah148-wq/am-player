#!/usr/bin/env python3
"""
arsc_strings.py — pull the full Android string table out of resources.arsc.

We lost res/values/strings.xml in the re-shuffle, but the compiled resource
table is still in the APK extraction. This walks:

    ResTable_header (0x0002)
      └ global ResStringPool (0x0001)      <- value strings live here
      └ ResTable_package   (0x0200)
           ├ typeStrings pool (0x0001)     <- "string", "layout", ...
           ├ keyStrings  pool (0x0001)     <- "effect_glow_name", ...
           └ ResTable_type    (0x0201)     <- entries for one (type, config)

For every type chunk whose type id is "string", we read each non-complex
entry: key -> Res_value(type=TYPE_STRING) -> index into the GLOBAL pool.

Output: reference/app_strings.json  { key: text }

Pure stdlib, no aapt needed.
"""
import json, os, struct, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARSC = os.path.join(ROOT, "apk-analysis", "Alight motion ", "resources.arsc")
OUT  = os.path.join(ROOT, "reference", "app_strings.json")

RES_STRING_POOL_TYPE      = 0x0001
RES_TABLE_TYPE            = 0x0002
RES_TABLE_PACKAGE_TYPE    = 0x0200
RES_TABLE_TYPE_TYPE       = 0x0201

UTF8_FLAG = 0x100
SPARSE_FLAG = 0x01
COMPLEX_FLAG = 0x0001

TYPE_STRING = 0x03


class R:
    """little-endian cursor"""
    def __init__(self, buf, pos=0):
        self.b = buf; self.p = pos

    def u8(self):
        v = self.b[self.p]; self.p += 1; return v

    def u16(self):
        v = struct.unpack_from('<H', self.b, self.p)[0]; self.p += 2; return v

    def u32(self):
        v = struct.unpack_from('<I', self.b, self.p)[0]; self.p += 4; return v

    def raw(self, n):
        v = self.b[self.p:self.p + n]; self.p += n; return v


def _len8(r):
    """utf8 string length: 1 or 2 bytes, high bit = escape"""
    first = r.u8()
    if first & 0x80:
        return ((first & 0x7F) << 8) | r.u8()
    return first


def _len16(r):
    first = r.u16()
    if first & 0x8000:
        return ((first & 0x7FFF) << 16) | r.u16()
    return first


def parse_string_pool(buf, off):
    """off = chunk start. returns list of str"""
    r = R(buf, off)
    typ = r.u16(); hdr = r.u16(); size = r.u32()
    if typ != RES_STRING_POOL_TYPE:
        raise ValueError('not a string pool at %d (type=0x%04x)' % (off, typ))
    count = r.u32(); _style_count = r.u32(); flags = r.u32()
    strings_start = r.u32(); _styles_start = r.u32()

    offsets = [r.u32() for _ in range(count)]
    out = []
    base = off + strings_start
    utf8 = bool(flags & UTF8_FLAG)
    for so in offsets:
        if so == 0xFFFFFFFF:
            out.append('')
            continue
        p = base + so
        rr = R(buf, p)
        if utf8:
            _nchars = _len8(rr)
            nbytes = _len8(rr)
            out.append(rr.raw(nbytes).decode('utf-8', 'replace'))
        else:
            n = _len16(rr)
            raw = rr.raw(n * 2)
            out.append(raw.decode('utf-16-le', 'replace'))
    return out


def parse_package(buf, off, gpool):
    """returns {key: text} for string resources in this package"""
    r = R(buf, off)
    typ = r.u16(); hdr = r.u16(); size = r.u32()
    if typ != RES_TABLE_PACKAGE_TYPE:
        raise ValueError('not a package at %d' % off)
    pkg_id = r.u32()
    pkg_name = r.raw(256).decode('utf-16-le', 'replace').split('\x00')[0]
    type_strings_off = r.u32()
    _last_public_type = r.u32()
    key_strings_off = r.u32()
    _last_public_key = r.u32()

    types = parse_string_pool(buf, off + type_strings_off)
    keys = parse_string_pool(buf, off + key_strings_off)

    out = {}
    p = off + hdr                       # chunks after the package header
    end = off + size
    while p + 8 <= end:
        rr = R(buf, p)
        ct = rr.u16(); ch = rr.u16(); cs = rr.u32()
        if cs < 8:
            break
        if ct == RES_TABLE_TYPE_TYPE and cs >= 24:
            parse_type_chunk(buf, p, ch, cs, types, keys, gpool, out)
        p += cs
    return pkg_name, pkg_id, out


def parse_type_chunk(buf, off, hdr, size, types, keys, gpool, out):
    r = R(buf, off)
    r.u16(); r.u16(); r.u32()          # type, headerSize, chunkSize
    type_id = r.u8()
    flags = r.u8()
    r.u16()
    entry_count = r.u32()
    entries_start = r.u32()
    r.u32()                             # config size

    if type_id - 1 >= len(types) or types[type_id - 1] != 'string':
        return

    # entry offsets begin right after the chunk header
    r.p = off + hdr
    if flags & SPARSE_FLAG:
        pairs = [(r.u16(), r.u16()) for _ in range(entry_count)]
        idx_off = pairs
    else:
        idx_off = [(i, r.u32()) for i in range(entry_count)]

    for _idx, eoff in idx_off:
        if eoff == 0xFFFFFFFF or eoff == 0:
            continue
        ep = off + entries_start + eoff
        if ep + 8 > len(buf):
            continue
        er = R(buf, ep)
        esize = er.u16(); eflags = er.u16(); ekey = er.u32()
        if eflags & COMPLEX_FLAG:
            continue
        if ekey >= len(keys):
            continue
        # Res_value
        vs = er.u16(); _res0 = er.u8(); vtype = er.u8(); vdata = er.u32()
        if vtype == TYPE_STRING and vdata < len(gpool):
            text = gpool[vdata]
            if text:
                out.setdefault(keys[ekey], text)


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else ARSC
    if not os.path.exists(path):
        print('resources.arsc tidak ditemukan:', path, file=sys.stderr)
        return 1
    buf = open(path, 'rb').read()

    r = R(buf, 0)
    typ = r.u16(); hdr = r.u16(); size = r.u32(); pkg_count = r.u32()
    if typ != RES_TABLE_TYPE:
        print('bukan ResTable (type=0x%04x)' % typ, file=sys.stderr)
        return 1

    # global value string pool = first chunk after the table header
    p = hdr
    gpool = []
    while p + 8 <= len(buf):
        rr = R(buf, p)
        ct = rr.u16(); ch = rr.u16(); cs = rr.u32()
        if cs < 8:
            break
        if ct == RES_STRING_POOL_TYPE:
            gpool = parse_string_pool(buf, p)
            break
        p += cs
    if not gpool:
        print('global string pool kosong', file=sys.stderr)
        return 1

    merged = {}
    packages = []
    p = hdr
    while p + 8 <= len(buf):
        rr = R(buf, p)
        ct = rr.u16(); ch = rr.u16(); cs = rr.u32()
        if cs < 8:
            break
        if ct == RES_TABLE_PACKAGE_TYPE:
            name, pid, entries = parse_package(buf, p, gpool)
            packages.append((pid, name, len(entries)))
            for k, v in entries.items():
                merged.setdefault(k, v)
        p += cs

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf8') as f:
        json.dump(merged, f, ensure_ascii=False, sort_keys=True)

    print('global pool strings :', len(gpool))
    print('packages            :', packages)
    print('extracted keys      :', len(merged))
    print('output              :', OUT)
    for probe in ('effect_glow_name', 'effect_param_radius', 'effect_brightcont_name'):
        print('  probe %-28s = %r' % (probe, merged.get(probe)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
