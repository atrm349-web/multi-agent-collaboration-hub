#!/usr/bin/env python3
"""DS-01 baseline verification.

Read-only. Recomputes every SHA-256 the shared project claims for the current
baseline and records the verdict per artifact. Run from anywhere:

    python3 baseline-check.py [shared-root] [--json out.json]

Default shared root: /Users/anyunhong/Desktop/集合agent
"""
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

DEFAULT_ROOT = "/Users/anyunhong/Desktop/集合agent"


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def verdict(recorded, actual):
    if recorded is None:
        return "unrecorded"
    if actual is None:
        return "missing"
    return "match" if recorded == actual else "mismatch"


def mtime(path):
    try:
        return datetime.fromtimestamp(os.stat(path).st_mtime, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except OSError:
        return None


def check(root, rel, recorded, source, group):
    full = os.path.join(root, rel)
    actual = sha256(full) if os.path.isfile(full) else None
    return {
        "group": group,
        "path": rel,
        "recordedIn": source,
        "recorded": recorded,
        "actual": actual,
        "verdict": verdict(recorded, actual),
        "mtimeUtc": mtime(full),
    }


def git(root, backend, *args):
    try:
        out = subprocess.run(
            ["git", "-C", os.path.join(root, backend), *args],
            capture_output=True, text=True, check=False,
        )
        return out.stdout.strip()
    except OSError:
        return None


def main():
    root = DEFAULT_ROOT
    out_path = None
    argv = sys.argv[1:]
    if "--json" in argv:
        i = argv.index("--json")
        out_path = argv[i + 1]
        del argv[i:i + 2]
    if argv:
        root = argv[0]

    backend = "backend/agetor"
    lock_rel = f"{backend}/docs/hub/frontend-source-lock.json"
    lock = json.load(open(os.path.join(root, lock_rel)))
    ag = json.load(open(os.path.join(root, "Antigravity/handoff-manifest.json")))
    codex_delivery = os.path.join(root, "Codex/backend-deliveries/F02-r3")

    checks = []

    # 1. Backend source-lock claims (the signature Codex actually relied on).
    for rel, recorded in lock["backendHashes"].items():
        checks.append(check(root, f"{backend}/{rel}", recorded, "frontend-source-lock.json/backendHashes", "backend-lock"))
    for name, recorded in lock["sourceHashes"].items():
        checks.append(check(root, f"apps/web/public/{name}", recorded, "frontend-source-lock.json/sourceHashes", "frontend-vs-codex-lock"))
    for name, recorded in lock["nativeBundleHashes"].items():
        checks.append(check(root, f"Codex/backend-deliveries/F02-r3/{name}", recorded, "frontend-source-lock.json/nativeBundleHashes", "codex-native-bundle"))

    # 2. Antigravity's own handoff manifest.
    ag_results = [check(root, rel, recorded, "Antigravity/handoff-manifest.json", "antigravity-manifest") for rel, recorded in ag["files"].items()]

    # 3. Codex F02-r3 package integrity (27 files, self-declared).
    codex_sha = json.load(open(os.path.join(codex_delivery, "SHA256.json")))
    codex_results = [
        {
            "group": "codex-f02-r3-package",
            "path": f"Codex/backend-deliveries/F02-r3/{rel}",
            "recordedIn": "Codex/backend-deliveries/F02-r3/SHA256.json",
            "recorded": recorded,
            "actual": sha256(os.path.join(codex_delivery, rel)) if os.path.isfile(os.path.join(codex_delivery, rel)) else None,
            "verdict": verdict(recorded, sha256(os.path.join(codex_delivery, rel)) if os.path.isfile(os.path.join(codex_delivery, rel)) else None),
            "mtimeUtc": mtime(os.path.join(codex_delivery, rel)),
        }
        for rel, recorded in codex_sha.items()
    ]

    summary = {}
    for row in checks + ag_results + codex_results:
        s = summary.setdefault(row["group"], {"match": 0, "mismatch": 0, "missing": 0, "unrecorded": 0})
        s[row["verdict"]] += 1

    report = {
        "schemaVersion": 1,
        "generatedBy": "DeepSeek DS-01",
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sharedRoot": root,
        "backendGit": {
            "branch": git(root, backend, "rev-parse", "--abbrev-ref", "HEAD"),
            "head": git(root, backend, "rev-parse", "HEAD"),
            "status": git(root, backend, "status", "--porcelain"),
        },
        "sourceLock": {
            "path": lock_rel,
            "delivery": lock.get("delivery"),
            "checkedAt": lock.get("checkedAt"),
            "reviewStatus": lock.get("reviewStatus"),
            "runtimeEnforced": lock.get("runtimeEnforced"),
        },
        "summary": summary,
        "checks": checks,
        "antigravityManifest": ag_results,
        "codexPackage": codex_results,
    }

    text = json.dumps(report, indent=2, ensure_ascii=False)
    print(text if not out_path else json.dumps({k: report[k] for k in ("summary", "backendGit", "sourceLock")}, indent=2, ensure_ascii=False))
    if out_path:
        with open(out_path, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
        print(f"\nwrote {out_path}")


if __name__ == "__main__":
    main()
