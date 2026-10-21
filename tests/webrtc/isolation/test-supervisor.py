#!/usr/bin/env python3
"""Verify supervised native Chromium termination after policy loss/mutation."""
import argparse
import glob
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parents[3]


def browser():
    child = subprocess.Popen([os.environ["RUNWAY_BROWSER_EXECUTABLE"], "--no-sandbox",
                              "--headless", "--disable-gpu", "--remote-debugging-port=9222", "about:blank"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    Path(os.environ["SUPERVISOR_READY"]).write_text(str(child.pid))
    return child.wait()


def verify(output):
    output.mkdir(parents=True, exist_ok=True)
    with socket.socket() as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("0.0.0.0", 13478))
        listener.listen()
        def accept():
            while True:
                try:
                    peer, _ = listener.accept()
                    peer.close()
                except OSError:
                    return
        threading.Thread(target=accept, daemon=True).start()
        receipts = []
        for mutation in ["delete", "extra-allow"]:
            directory = output / mutation
            directory.mkdir()
            ready = directory / "browser.pid"
            executable = sorted(glob.glob("/ms-playwright/chromium-*/chrome-linux*/chrome"))[-1]
            env = dict(os.environ, WEBRTC_DIRECT_CONTROL="0", PLAYWRIGHT_CHROMIUM_EXECUTABLE=executable,
                       EVIDENCE_DIR=str(directory), SUPERVISOR_READY=str(ready), PYTHONDONTWRITEBYTECODE="1")
            with (directory / "supervisor.log").open("w") as log:
                supervisor = subprocess.Popen(["bash", str(ROOT / "tests/webrtc/isolation/run-in-netns.sh"),
                                                "--", "python3", str(Path(__file__).resolve()), "--browser"],
                                               env=env, stdout=log, stderr=log)
                try:
                    deadline = time.monotonic() + 30
                    while not ready.exists():
                        if supervisor.poll() is not None or time.monotonic() > deadline:
                            raise AssertionError("supervised browser did not launch; see supervisor.log")
                        time.sleep(.1)
                    browser_pid = int(ready.read_text())
                    # A live DevTools listener proves Chromium completed startup
                    # inside the isolated namespace before its policy is changed.
                    while True:
                        check = subprocess.run(["ip", "netns", "exec", "sjclient", "ss", "-ltnp"],
                                               capture_output=True, text=True)
                        if check.returncode == 0 and ":9222" in check.stdout:
                            break
                        if supervisor.poll() is not None or time.monotonic() > deadline:
                            raise AssertionError("native Chromium never became ready")
                        time.sleep(.1)
                    pids = subprocess.check_output(["ip", "netns", "pids", "sjclient"], text=True).split()
                    assert str(browser_pid) in pids, "browser is outside the supervised namespace"
                    started = time.monotonic()
                    command = (["delete", "table", "inet", "scramjet_webrtc"] if mutation == "delete" else
                               ["insert", "rule", "inet", "scramjet_webrtc", "output", "tcp", "dport", "19999", "accept"])
                    subprocess.run(["ip", "netns", "exec", "sjclient", "nft", *command], check=True)
                    code = supervisor.wait(timeout=10)
                    elapsed = time.monotonic() - started
                    text = (directory / "supervisor.log").read_text()
                    assert code == 1 and "network isolation policy changed; supervised browser stopped" in text
                    assert "sjclient" not in subprocess.check_output(["ip", "netns", "list"], text=True)
                    assert subprocess.run(["ip", "link", "show", "sjveth0"], capture_output=True).returncode != 0
                    def surviving():
                        live = []
                        for pid in pids:
                            state = Path("/proc") / pid / "stat"
                            try:
                                if not state.read_text().split(") ", 1)[1].startswith("Z"):
                                    live.append(pid)
                            except FileNotFoundError:
                                pass
                        return live
                    deadline = time.monotonic() + 5
                    while surviving() and time.monotonic() < deadline:
                        time.sleep(.05)
                    assert not surviving(), f"namespace processes survive: {surviving()}"
                    receipts.append({"mutation": mutation, "nativeBrowserReady": True,
                                     "exitCode": code, "elapsedSeconds": round(elapsed, 3),
                                     "browserTerminated": True, "namespaceRemoved": True, "ok": True})
                finally:
                    if supervisor.poll() is None:
                        supervisor.terminate()
                        supervisor.wait(timeout=10)
        return {"cases": receipts, "ok": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=False)
    parser.add_argument("--image", default="scramjet-webrtc-linux-verification:local")
    parser.add_argument("--browser", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--inside", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.browser:
        return browser()
    if args.output is None:
        parser.error("--output is required")
    output = args.output.resolve()
    if args.inside:
        result = verify(output)
        result.update(scriptSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                      supervisorSha256=hashlib.sha256((ROOT / "tests/webrtc/isolation/run-in-netns.sh").read_bytes()).hexdigest())
        (output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result))
        return 0
    output.mkdir(parents=True, exist_ok=True)
    name = "sj-supervisor-" + secrets.token_hex(5)
    result = subprocess.run(["docker", "run", "--rm", "--name", name, "--privileged", "--network", "none",
                             "-v", f"{ROOT}:{ROOT}:ro", "-v", f"{output}:{output}", "--entrypoint", "python3", args.image,
                             str(Path(__file__).resolve()), "--inside", "--output", str(output)])
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
