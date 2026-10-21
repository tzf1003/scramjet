#!/usr/bin/env python3
"""Re-run unexpected existing tests against a retained baseline distribution."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument("--current-results", required=True)
parser.add_argument("--baseline-dist", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
output = Path(args.output).resolve()
output.mkdir(parents=True, exist_ok=True)
baseline = Path(args.baseline_dist).resolve()
if not all((baseline / name).is_file() for name in ("scramjet.js", "scramjet.mjs", "scramjet.wasm")):
    parser.error("baseline distribution must contain scramjet.js, scramjet.mjs, and scramjet.wasm")
current = json.loads(Path(args.current_results).read_text())
expected = set(json.loads((ROOT / "packages/runway/failing_tests.json").read_text())["tests"])
targets = [test["name"] for test in current["tests"] if test["result"]["status"] != "pass" and test["name"] not in expected and not test["name"].startswith("webrtc-")]
if not targets:
    (output / "comparison.json").write_text(json.dumps({"unexpectedExisting": [], "newRegressions": []}, indent=2) + "\n")
    raise SystemExit(0)
with tempfile.TemporaryDirectory(prefix="runway-baseline-", dir=output) as directory:
    stage = Path(directory)
    shutil.copytree(ROOT / "packages/runway/src", stage / "src")
    modules = stage / "node_modules"
    modules.mkdir()
    for dependency in (ROOT / "packages/runway/node_modules").iterdir():
        if dependency.name == "@mercuryworkshop": continue
        (modules / dependency.name).symlink_to(dependency.resolve(), target_is_directory=True)
    namespace = modules / "@mercuryworkshop"
    namespace.mkdir()
    for dependency in (ROOT / "packages/runway/node_modules/@mercuryworkshop").iterdir():
        if dependency.name == "scramjet": continue
        (namespace / dependency.name).symlink_to(dependency.resolve(), target_is_directory=True)
    core = namespace / "scramjet"
    core.mkdir()
    (core / "package.json").write_bytes((ROOT / "packages/core/package.json").read_bytes())
    (core / "dist").symlink_to(baseline, target_is_directory=True)
    (core / "lib").symlink_to(ROOT / "packages/core/lib", target_is_directory=True)
    # Bundled baseline JS may import shared transport dependencies.
    (core / "node_modules").symlink_to(ROOT / "packages/core/node_modules", target_is_directory=True)
    (stage / "failing_tests.json").write_bytes((ROOT / "packages/runway/failing_tests.json").read_bytes())
    (stage / "package.json").write_text('{"type":"module"}\n')
    runner = stage / "src/index.ts"
    source = runner.read_text()
    source = source.replace("const allTests = (await discoverTests()).filter(", "const baselineTargets = new Set(" + json.dumps(targets) + ");\nconst allTests = (await discoverTests()).filter((test) => baselineTargets.has(test.name)).filter(")
    runner.write_text(source)
    env = dict(os.environ, RUNWAY_SCRAMJET_DIST=str(baseline), WEBRTC_EVIDENCE_DIR=str(output),
               WEBRTC_RUN_ID="baseline-distribution-comparison", OMIT_WPT="1", RUNWAY_BROWSER="chromium")
    with (output / "baseline.log").open("w") as stream:
        result = subprocess.run(["npx", "--offline", "node@24", "--experimental-strip-types", "--no-warnings", "src/index.ts", "--parallel", "1"],
                                cwd=stage, env=env, stdout=stream, stderr=subprocess.STDOUT)
    if not (output / "chromium-results.json").is_file():
        raise SystemExit(f"baseline runner exited {result.returncode} before producing results; inspect {output / 'baseline.log'}")
    observed = json.loads((output / "chromium-results.json").read_text())
    baseline_failed = {test["name"] for test in observed["tests"] if test["result"]["status"] != "pass"}
    comparison = {"baselineSha256": hashlib.sha256((baseline / "scramjet.js").read_bytes()).hexdigest(),
                  "baselineDistribution": str(baseline), "baselineCommandExitCode": result.returncode,
                  "unexpectedExisting": targets, "alsoFailWithBaseline": sorted(set(targets) & baseline_failed),
                  "newRegressions": sorted(set(targets) - baseline_failed),
                  "scope": "same current runner and controller; baseline browser and bundled Core distribution; WebRTC-specific additions excluded"}
    (output / "comparison.json").write_text(json.dumps(comparison, indent=2) + "\n")
    print(json.dumps(comparison), flush=True)
    raise SystemExit(1 if comparison["newRegressions"] else 0)
