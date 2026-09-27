#!/usr/bin/env python3
"""Validate the checked-in Web effect registry and generated shader files."""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGISTRY = os.path.join(ROOT, "webfx", "effects.json")

def main():
    with open(REGISTRY, encoding="utf-8") as f:
        data = json.load(f)
    effects = data.get("effects", [])
    errors, warnings, ids, files = [], [], set(), set()
    for effect in effects:
        eid, file_name = effect.get("id"), effect.get("file")
        if not eid or not file_name:
            errors.append("effect tanpa id/file")
            continue
        if eid in ids:
            errors.append(f"duplicate effect id: {eid}")
        ids.add(eid)
        for shader in effect.get("shaders", []):
            src = shader.get("src")
            if not src:
                errors.append(f"{eid}: shader tanpa src")
                continue
            path = os.path.join(ROOT, "webfx", src.replace("/", os.sep))
            if not os.path.isfile(path):
                errors.append(f"{eid}: shader hilang: {src}")
            files.add(src)
        params = effect.get("params", [])
        param_ids = set()
        for param in params:
            pid = param.get("id")
            if not pid:
                errors.append(f"{eid}: param tanpa id")
            elif pid in param_ids:
                errors.append(f"{eid}: duplicate param: {pid}")
            param_ids.add(pid)
        for p in effect.get("passes", []):
            target = p.get("target")
            if target and target not in param_ids:
                warnings.append(f"{eid}: pass target tidak ada di params: {target}")
    expected = data.get("count")
    if expected is not None and int(expected) != len(effects):
        warnings.append(f"count metadata {expected} != effects {len(effects)}")
    print(f"effects={len(effects)} shaders={len(files)} ids={len(ids)}")
    for warning in warnings:
        print("WARN:", warning)
    if errors:
        for error in errors:
            print("ERROR:", error, file=sys.stderr)
        return 1
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
