"""Control only the disposable TURN owned by a test runner, outside the browser."""
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import re
import time


def owned_relay_sockets(turn, relay_range):
    # Coturn may close an allocation between enumerating and resolving FDs.
    # Ignore only descriptors that disappeared; fail on a live unreadable FD.
    inspect = r'''
set -eu
ls /proc/1/fd >/dev/null
for fd in /proc/1/fd/*; do
    if target=$(readlink "$fd" 2>/dev/null); then
        printf '%s\n' "$target"
    elif [ -L "$fd" ]; then
        printf 'Cannot read live Coturn descriptor %s\n' "$fd" >&2
        exit 1
    fi
done
'''
    prefix = ["docker", "exec", "--privileged", "-u", "0", turn]
    fds = subprocess.check_output([*prefix, "sh", "-c", inspect], text=True, stderr=subprocess.STDOUT, timeout=30)
    inodes = set(re.findall(r"socket:\[(\d+)\]", fds))
    udp = subprocess.check_output([*prefix, "cat", "/proc/net/udp", "/proc/net/udp6"], text=True, stderr=subprocess.STDOUT, timeout=30)
    return sorted({parts[9] for line in udp.splitlines()
                   if len(parts := line.split()) > 9 and parts[9] in inodes and
                   relay_range[0] <= int(parts[1].split(":")[-1], 16) <= relay_range[1]})


def runner_timeouts(env):
    """Allow declared soak durations while bounding silent and total runtime."""
    soak = float(env.get("WEBRTC_SOAK_SECONDS", "15"))
    media = float(env.get("WEBRTC_MEDIA_SOAK_SECONDS", "2.5"))
    allowance = max(soak, media * 10)
    idle = float(env.get("WEBRTC_RUN_IDLE_TIMEOUT_SECONDS", str(300 + allowance)))
    total = float(env.get("WEBRTC_RUN_TIMEOUT_SECONDS", str(1800 + allowance * 2)))
    if not all(math.isfinite(value) and value > 0 for value in (soak, media, idle, total)):
        raise ValueError("runner timeouts and soak durations must be finite positive seconds")
    return idle, total


def stop_process(process, grace_seconds):
    """Stop the owned session, including descendants that ignore termination."""
    def send(sig):
        try:
            if os.name == "posix":
                os.killpg(process.pid, sig)
            else:
                process.send_signal(sig)
        except ProcessLookupError:
            pass
    send(signal.SIGTERM)
    try:
        process.wait(timeout=grace_seconds)
    except subprocess.TimeoutExpired:
        pass
    finally:
        send(signal.SIGKILL)
        process.wait(timeout=grace_seconds)


def run_controlled(args, *, output, turn, stream, relay_range=(50160, 50200), network_exec=None, interface="sjveth1",
                   idle_seconds=None, max_seconds=None, terminate_grace_seconds=10, **kwargs):
    output = Path(output)
    default_idle, default_max = runner_timeouts(kwargs.get("env", os.environ))
    idle_seconds = default_idle if idle_seconds is None else idle_seconds
    max_seconds = default_max if max_seconds is None else max_seconds
    if not all(math.isfinite(value) and value > 0 for value in (idle_seconds, max_seconds, terminate_grace_seconds)):
        raise ValueError("runner deadlines must be finite positive seconds")
    request = output / "turn-request.json"
    response = output / "turn-response.json"
    request.unlink(missing_ok=True)
    response.unlink(missing_ok=True)
    watchdog_file = output / (Path(stream.name).name + ".watchdog.json")
    watchdog_file.unlink(missing_ok=True)
    history = []
    previous = None
    process = subprocess.Popen(args, stdout=stream, stderr=subprocess.STDOUT,
                               start_new_session=os.name == "posix", **kwargs)
    started = last_progress = time.monotonic()
    last_size = os.fstat(stream.fileno()).st_size
    link_down = False
    routes = {}
    addresses = []
    def link(state):
        nonlocal addresses
        if not network_exec:
            raise ValueError("owned client network context is required")
        policy = json.loads((output / "policy.json").read_text())
        actual = subprocess.check_output([*network_exec, "readlink", "/proc/self/ns/net"], text=True, timeout=30).strip()
        if actual != policy["networkNamespace"]:
            raise ValueError("network context does not match the installed policy")
        if state == "down":
            addresses = json.loads(subprocess.check_output([*network_exec, "ip", "-json", "address", "show", "dev", interface], text=True, timeout=30))[0]["addr_info"]
            for family in ("-4", "-6"):
                routes[family] = json.loads(subprocess.check_output([*network_exec, "ip", "-json", family, "route", "show", "default"], text=True, timeout=30))
        subprocess.run([*network_exec, "ip", "link", "set", interface, state], check=True, capture_output=True, timeout=30)
        if state == "up":
            for address in addresses:
                if address.get("scope") != "global": continue
                family = "-6" if address["family"] == "inet6" else "-4"
                invocation = [*network_exec, "ip", family, "address", "replace", f'{address["local"]}/{address["prefixlen"]}', "dev", interface]
                if family == "-6": invocation.append("nodad")
                subprocess.run(invocation, check=True, capture_output=True, timeout=30)
            # Linux removes IPv6 default routes on link-down. Restore the exact
            # task-owned route so this is a recoverable network fault.
            for family, entries in routes.items():
                for route in entries:
                    if route.get("dev") != interface or not route.get("gateway"):
                        raise ValueError("unexpected default route in the owned namespace")
                    subprocess.run([*network_exec, "ip", family, "route", "replace", "default", "via", route["gateway"], "dev", interface], check=True, capture_output=True, timeout=30)
    try:
        while process.poll() is None:
            now = time.monotonic()
            size = os.fstat(stream.fileno()).st_size
            if size != last_size:
                last_progress, last_size = now, size
            reason = ("total-runtime" if now - started >= max_seconds else
                      "no-log-progress" if now - last_progress >= idle_seconds else None)
            if reason:
                diagnostic = {"reason": reason, "exitCode": 124, "pid": process.pid,
                              "elapsedSeconds": round(now - started, 3),
                              "idleSeconds": round(now - last_progress, 3),
                              "idleLimitSeconds": idle_seconds, "totalLimitSeconds": max_seconds,
                              "log": Path(stream.name).name}
                watchdog_file.write_text(json.dumps(diagnostic, indent=2) + "\n")
                print("Runway watchdog: " + json.dumps(diagnostic), file=stream, flush=True)
                return 124
            try:
                value = json.loads(request.read_text())
            except (OSError, ValueError):
                value = None
            if isinstance(value, dict) and value.get("id") != previous:
                previous = value.get("id")
                action = value.get("action")
                if action in ("link-down", "link-up"):
                    try:
                        link("down" if action == "link-down" else "up")
                        link_down = action == "link-down"
                        result = {"id": previous, "action": action, "ok": True, "at": time.time()}
                    except (OSError, ValueError, subprocess.CalledProcessError) as error:
                        result = {"id": previous, "ok": False, "error": str(error)}
                elif action == "snapshot":
                    try:
                        allocated = owned_relay_sockets(turn, relay_range)
                        result = {"id": previous, "action": action, "ok": True, "ownedRelaySockets": len(allocated), "relaySocketIds": allocated, "at": time.time()}
                    except subprocess.CalledProcessError as error:
                        result = {"id": previous, "ok": False, "error": str(error),
                                  "diagnostic": (error.output or "")[-2000:]}
                elif action not in ("pause", "unpause", "restart"):
                    result = {"id": previous, "ok": False, "error": "unsupported TURN test action"}
                else:
                    run = subprocess.run(["docker", action, turn], capture_output=True, text=True, timeout=60)
                    result = {"id": previous, "action": action, "ok": run.returncode == 0,
                              "at": time.time(), "error": run.stderr.strip() if run.returncode else None}
                history.append(result)
                staging = output / "turn-response.tmp"
                staging.write_text(json.dumps(result))
                staging.replace(response)
            time.sleep(0.05)
        return process.wait()
    finally:
        if link_down:
            try:
                link("up")
            except (OSError, ValueError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
                pass  # The supervised launcher may already have deleted its namespace.
        try:
            if os.name == "posix" or process.poll() is None:
                stop_process(process, terminate_grace_seconds)
        finally:
            try:
                subprocess.run(["docker", "unpause", turn], capture_output=True, timeout=15)
            finally:
                (output / "turn-control.json").write_text(json.dumps(history, indent=2) + "\n")
