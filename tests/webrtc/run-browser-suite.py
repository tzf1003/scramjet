#!/usr/bin/env python3
"""Run real browser suites against a task-owned, disposable Coturn stack."""
import argparse
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import time
import urllib.request
from runner_control import run_controlled
from evidence import source_identity, write_manifest

ROOT = Path(__file__).resolve().parents[2]
IMAGE = "coturn/coturn:4.18.0-r0@sha256:bbefd3e1fdfdc0d58770fe01b581fd8b00d9f3a5580d00acb77cf719a6bc78e3"


def command(*args, **kwargs):
    return subprocess.run(list(args), **kwargs)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--browser", action="append", choices=["chromium", "firefox", "webkit"])
    parser.add_argument("--filter", default="webrtc-")
    parser.add_argument("--parallel", type=int, default=1)
    parser.add_argument("--transport", choices=["udp", "tcp", "tls"], default="udp")
    args = parser.parse_args()
    if args.parallel != 1:
        parser.error("--parallel must be 1: TURN fault injection owns the shared relay; connection concurrency is tested inside each test")
    output = Path(args.output).resolve(); output.mkdir(parents=True, exist_ok=True)
    identity = source_identity(ROOT)
    (output / "source.json").write_text(json.dumps(identity, indent=2) + "\n")
    subprocess.run(["sh", str(ROOT / "tests/webrtc/coturn/generate-certs.sh")],
                   check=True, capture_output=True, text=True)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as route:
        route.connect(("1.1.1.1", 53)); host = route.getsockname()[0]
    run_id = "sj-webrtc-" + secrets.token_hex(5)
    env = os.environ.copy()
    url = (f"turns:{host}:15351?transport=tcp" if args.transport == "tls" else f"turn:{host}:13480?transport={args.transport}")
    env.update(TURN_STATIC_AUTH_SECRET=secrets.token_hex(32), TURN_EXTERNAL_IP=host,
               TURN_TEST_ALLOW_SELF="1", TURN_ALLOWED_PEER_IP=host + ",127.0.0.1,172.17.0.1",
               TURN_LISTENING_PORT="13480", TURN_TLS_PORT="15351", TURN_MIN_PORT="50350", TURN_MAX_PORT="50390",
               TURN_URLS=url, TURN_TTL=os.environ.get("TURN_TTL", "120"), PORT="18082", ALLOWED_ORIGIN="*",
               ALLOW_ANONYMOUS_TEST_ONLY="1", CREDENTIAL_RATE_LIMIT="1000")
    owned = []
    try:
        for suffix, image, options, keys, cmd in [
            ("turn", IMAGE, ["--entrypoint", "/bin/sh", "-p", "13480:13480/udp", "-p", "13480:13480/tcp",
                "-p", "15351:15351/tcp", "-p", "50350-50390:50350-50390/udp",
                "-v", str(ROOT / "tests/webrtc/coturn") + ":/etc/coturn:ro",
                "-v", str(ROOT / "tests/webrtc/coturn/entrypoint.sh") + ":/opt/coturn/entrypoint.sh:ro"],
                ["TURN_STATIC_AUTH_SECRET", "TURN_EXTERNAL_IP", "TURN_TEST_ALLOW_SELF", "TURN_ALLOWED_PEER_IP",
                 "TURN_LISTENING_PORT", "TURN_TLS_PORT", "TURN_MIN_PORT", "TURN_MAX_PORT"], ["/opt/coturn/entrypoint.sh"]),
            ("credentials", "node:22-alpine", ["-p", "127.0.0.1:18082:18082", "-v", str(ROOT / "tests/webrtc/server") + ":/app:ro"],
                ["TURN_STATIC_AUTH_SECRET", "TURN_URLS", "TURN_TTL", "PORT", "ALLOWED_ORIGIN", "ALLOW_ANONYMOUS_TEST_ONLY", "CREDENTIAL_RATE_LIMIT"],
                ["node", "/app/credential-server.mjs"]),
        ]:
            name = run_id + "-" + suffix
            invocation = ["docker", "run", "-d", "--rm", "--name", name, *options]
            for key in keys: invocation += ["--env", key]
            result = command(*invocation, image, *cmd, env=env, capture_output=True, text=True)
            if result.returncode: raise RuntimeError(result.stderr)
            owned.append(name)
        for attempt in range(60):
            try:
                with urllib.request.urlopen("http://127.0.0.1:18082/healthz", timeout=1) as response:
                    if response.status == 200: break
            except OSError: time.sleep(0.2)
        else: raise RuntimeError("credential service did not start")
        results = []
        for browser in args.browser or ["chromium", "firefox", "webkit"]:
            test_env = dict(os.environ, TURN_CREDENTIALS_URL="http://127.0.0.1:18082/turn-credentials",
                            RUNWAY_BROWSER=browser, WEBRTC_FAKE_MEDIA="1", WEBRTC_EXPOSE_HOST_CANDIDATES="1",
                            WEBRTC_INSECURE_TLS="1" if args.transport == "tls" else "0", WEBRTC_RUN_ID=run_id,
                            WEBRTC_EVIDENCE_DIR=str(output), WEBRTC_TURN_CONTROL_DIR=str(output))
            started = time.monotonic()
            node_major = int(command("node", "--version", capture_output=True, text=True).stdout.strip().split(".")[0][1:])
            node = ["node"] if node_major >= 24 else ["npx", "--offline", "node@24"]
            invocation = [*node, "--experimental-strip-types", "--no-warnings", "src/index.ts", args.filter, "--parallel", str(args.parallel)]
            log = output / f"{browser}-{args.transport}.log"
            with log.open("w") as stream:
                exit_code = run_controlled(invocation, output=output, turn=run_id + "-turn", stream=stream,
                                           relay_range=(50350, 50390), cwd=ROOT / "packages/runway", env=test_env)
            item = {"browser": browser, "transport": args.transport, "exitCode": exit_code,
                    "elapsedSeconds": round(time.monotonic() - started, 2), "log": str(log)}
            print(json.dumps(item), flush=True); results.append(item)
        (output / "results.json").write_text(json.dumps({"runId": run_id, "image": IMAGE,
            "gitSha": identity["gitSha"], "sourceSha256": identity["sourceSha256"],
            "credentialTtlSeconds": env["TURN_TTL"], "dataSoakSeconds": os.environ.get("WEBRTC_SOAK_SECONDS", "15"),
            "mediaSecondsPerPhase": os.environ.get("WEBRTC_MEDIA_SOAK_SECONDS", "2.5"), "results": results}, indent=2) + "\n")
        return 1 if any(item["exitCode"] for item in results) else 0
    finally:
        for name in reversed(owned):
            logs = command("docker", "logs", name, capture_output=True, text=True)
            (output / (name.rsplit("-", 1)[-1] + ".log")).write_text(logs.stdout + logs.stderr)
            command("docker", "rm", "-f", name, capture_output=True)
        write_manifest(output)


if __name__ == "__main__":
    raise SystemExit(main())
