#!/usr/bin/env python3
"""Run the supervised browser suite in a task-owned Linux Docker environment."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tests/webrtc"))
from runner_control import run_controlled
from evidence import source_identity, write_manifest
TURN_IMAGE = "coturn/coturn:4.18.0-r0@sha256:bbefd3e1fdfdc0d58770fe01b581fd8b00d9f3a5580d00acb77cf719a6bc78e3"


def command(*args, **kwargs):
    return subprocess.run(list(args), check=True, text=True, **kwargs)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--image", default="scramjet-webrtc-linux-verification:local")
    parser.add_argument("--ipv6", action="store_true")
    parser.add_argument("--filter", default="webrtc-relay")
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    identity = source_identity(ROOT)
    (output / "source.json").write_text(json.dumps(identity, indent=2) + "\n")
    name = "sj-acceptance-" + secrets.token_hex(5)
    network = name + "-net"
    containers = []
    created_network = False
    secret = secrets.token_hex(32)
    started = time.monotonic()
    try:
        command("sh", str(ROOT / "tests/webrtc/coturn/generate-certs.sh"), capture_output=True)
        command("docker", "network", "create", "--ipv6", "--subnet", f"fd42:736a:{secrets.token_hex(2)}::/64", network, capture_output=True)
        created_network = True
        mounts = ["-v", f"{ROOT}:{ROOT}:ro", "-v", f"{output}:{output}"]
        shared_build = Path("/Volumes/1T/scramjet/build")
        if shared_build.exists(): mounts += ["-v", f"{shared_build}:{shared_build}:ro"]
        command("docker", "run", "-d", "--name", name, "--privileged", "--network", network,
                *mounts, "--entrypoint", "sleep", args.image, "infinity", capture_output=True)
        containers.append(name)
        addresses = json.loads(command("docker", "inspect", name, "--format", "{{json .NetworkSettings.Networks}}", capture_output=True).stdout)[network]
        ip4, ip6 = addresses["IPAddress"], addresses["GlobalIPv6Address"]
        host = f"[{ip6}]" if args.ipv6 else ip4
        urls = f"turn:{host}:13478?transport=udp"
        turn_env = dict(TURN_STATIC_AUTH_SECRET=secret, TURN_LISTENING_PORT="13478", TURN_TLS_PORT="15349",
                        TURN_MIN_PORT="50160", TURN_MAX_PORT="50200", TURN_EXTERNAL_IP=ip4,
                        TURN_ALLOWED_PEER_IP=",".join([ip4, ip6, "10.200.0.1", "10.200.0.2", "fd42:736a:1::1", "fd42:736a:1::2"]),
                        TURN_TEST_ALLOW_SELF="1",
                        # A TURN restart happens after the client veth exists.
                        # Bind allocations to stable server addresses so Coturn
                        # cannot discover/advertise a different veth allocation.
                        TURN_EXTRA_ARGS=f"--relay-ip={ip4} --relay-ip={ip6} " + os.environ.get("TURN_EXTRA_ARGS", ""))
        invocation = ["docker", "run", "-d", "--name", name + "-turn", "--network", "container:" + name,
                      "--entrypoint", "/bin/sh", "-v", f"{ROOT}/tests/webrtc/coturn:/etc/coturn:ro",
                      "-v", f"{ROOT}/tests/webrtc/coturn/entrypoint.sh:/opt/entrypoint.sh:ro"]
        for key, value in turn_env.items():
            invocation += ["--env", f"{key}={value}"]
        command(*invocation, TURN_IMAGE, "/opt/entrypoint.sh", capture_output=True)
        containers.append(name + "-turn")
        invocation = ["docker", "exec", "-d"]
        for key, value in dict(TURN_STATIC_AUTH_SECRET=secret, TURN_URLS=urls, TURN_TTL=os.environ.get("TURN_TTL", "120"), PORT="18081",
                               ALLOW_ANONYMOUS_TEST_ONLY="1", ALLOWED_ORIGIN="*", CREDENTIAL_RATE_LIMIT="1000").items():
            invocation += ["--env", f"{key}={value}"]
        command(*invocation, name, "node", str(ROOT / "tests/webrtc/server/credential-server.mjs"), capture_output=True)
        for _ in range(60):
            probe = subprocess.run(["docker", "exec", name, "node", "-e",
                                    "fetch('http://127.0.0.1:18081/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], capture_output=True)
            if probe.returncode == 0:
                break
            time.sleep(0.2)
        else:
            raise RuntimeError("credential service did not become healthy")
        executable = command("docker", "exec", name, "python3", "-c",
                             "import glob;print(sorted(glob.glob('/ms-playwright/chromium-*/chrome-linux*/chrome'))[-1])", capture_output=True).stdout.strip()
        env = dict(TURN_HOST=ip4, TURN_HOST_V6=ip6, SCRAMJET_HOST="10.200.0.1", SCRAMJET_PORT="4500",
                   TURN_CLIENT_RELAY_RANGE="1",
                   MASQUERADE="1", SCRAMJET_EXTRA_TCP_PORTS="18081,18083", WEBRTC_SIGNAL_PORT="18083",
                   PLAYWRIGHT_CHROMIUM_EXECUTABLE=executable, PLAYWRIGHT_BROWSERS_PATH="/ms-playwright",
                   WEBRTC_FAKE_MEDIA="1", EVIDENCE_DIR=str(output), PYTHONDONTWRITEBYTECODE="1",
                   WEBRTC_TURN_CONTROL_DIR=str(output),
                   TURN_CREDENTIALS_URL="http://10.200.0.1:18081/turn-credentials")
        for key in ("WEBRTC_SOAK_SECONDS", "WEBRTC_MEDIA_SOAK_SECONDS"):
            if key in os.environ:
                env[key] = os.environ[key]
        invocation = ["docker", "exec", "-w", str(ROOT / "packages/runway")]
        for key, value in env.items():
            invocation += ["--env", f"{key}={value}"]
        invocation += [name, "bash", str(ROOT / "tests/webrtc/isolation/run-in-netns.sh"), "--",
                       "node", "--experimental-strip-types", "--no-warnings", "src/index.ts", args.filter, "--parallel", "1"]
        with (output / "linux.log").open("w") as stream:
            exit_code = run_controlled(invocation, output=output, turn=name + "-turn", stream=stream,
                                      network_exec=["docker", "exec", name, "ip", "netns", "exec", "sjclient"])
        analysis = ["docker", "run", "--rm", "--network", "none", "-v", f"{output}:/evidence",
                    "-v", f"{ROOT}/tests/webrtc/capture:/scripts:ro", "nicolaka/netshoot", "python3",
                    "/scripts/check-client-egress.py", "/evidence/client.pcap", "--policy", "/evidence/policy.json",
                    "--receipt", "/evidence/isolation.json", "--output", "/evidence/client-egress.json"]
        checked = subprocess.run(analysis, capture_output=True, text=True)
        (output / "capture-analysis.log").write_text(checked.stdout + checked.stderr)
        negative = list(analysis)
        negative[negative.index("/evidence/client.pcap")] = "/evidence/negative-control.pcap"
        negative[negative.index("/evidence/client-egress.json")] = "/evidence/negative-egress.json"
        negative.append("--expect-unauthorized")
        negative_checked = subprocess.run(negative, capture_output=True, text=True)
        (output / "negative-analysis.log").write_text(negative_checked.stdout + negative_checked.stderr)
        metadata = {"exitCode": exit_code, "captureExitCode": checked.returncode,
                    "negativeControlExitCode": negative_checked.returncode, "ipv6Turn": args.ipv6, "filter": args.filter, "elapsedSeconds": round(time.monotonic() - started, 2),
                    "gitSha": command("git", "rev-parse", "HEAD", cwd=ROOT, capture_output=True).stdout.strip(),
                    "patchSha256": hashlib.sha256(command("git", "diff", "--binary", cwd=ROOT, capture_output=True).stdout.encode()).hexdigest(),
                    "image": args.image, "turnImage": TURN_IMAGE, "chromiumExecutable": executable}
        metadata["requestedDurations"] = {"dataSeconds": os.environ.get("WEBRTC_SOAK_SECONDS", "15"),
                                           "mediaSecondsPerPhase": os.environ.get("WEBRTC_MEDIA_SOAK_SECONDS", "2.5"),
                                           "credentialTtlSeconds": os.environ.get("TURN_TTL", "120")}
        metadata["sourceSha256"] = identity["sourceSha256"]
        (output / "run.json").write_text(json.dumps(metadata, indent=2) + "\n")
        print(json.dumps(metadata), flush=True)
        return 1 if exit_code or checked.returncode or negative_checked.returncode else 0
    finally:
        for container in reversed(containers):
            logs = subprocess.run(["docker", "logs", container], capture_output=True, text=True)
            (output / ("turn.log" if container.endswith("-turn") else "container.log")).write_text(logs.stdout + logs.stderr)
            subprocess.run(["docker", "rm", "-f", container], capture_output=True)
        if created_network:
            subprocess.run(["docker", "network", "rm", network], capture_output=True)
        write_manifest(output)


if __name__ == "__main__":
    raise SystemExit(main())
