"""Bind a test run to the exact tracked and task source files it exercised."""
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import time


def source_identity(root):
    root = Path(root)
    names = subprocess.check_output(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root).decode().split("\0")
    files = []
    for name in sorted(set(filter(None, names))):
        if not (name.startswith(("packages/", "tests/webrtc/", ".github/")) or name in ("package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "rspack.config.ts")):
            continue
        source = root / name
        if source.is_file():
            files.append({"path": name, "sha256": hashlib.sha256(source.read_bytes()).hexdigest()})
    digest = hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    bundles = []
    for package in ("core", "controller"):
        distribution = root / "packages" / package / "dist"
        for source in sorted(distribution.glob("*")):
            if source.is_file() and source.suffix in (".js", ".mjs", ".wasm"):
                bundles.append({"path": str(source.relative_to(root)),
                                "sha256": hashlib.sha256(source.read_bytes()).hexdigest()})
    return {"gitSha": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
            "sourceSha256": digest, "sourceFiles": files, "runtimeBundles": bundles,
            "recordedAt": time.time(), "runnerPlatform": platform.platform()}


def write_manifest(output):
    output = Path(output)
    files = []
    for source in sorted(output.rglob("*")):
        if not source.is_file() or source.name.startswith("._") or source.name == "manifest.json":
            continue
        files.append({"path": str(source.relative_to(output)), "bytes": source.stat().st_size,
                      "sha256": hashlib.sha256(source.read_bytes()).hexdigest()})
    (output / "manifest.json").write_text(json.dumps({"files": files}, indent=2) + "\n")
