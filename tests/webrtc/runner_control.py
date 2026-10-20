"""Control only the disposable TURN owned by a test runner, outside the browser."""
import json
from pathlib import Path
import subprocess
import re
import time


def run_controlled(args, *, output, turn, stream, relay_range=(50160, 50200), network_exec=None, interface="sjveth1", **kwargs):
    output = Path(output)
    request = output / "turn-request.json"
    response = output / "turn-response.json"
    request.unlink(missing_ok=True)
    response.unlink(missing_ok=True)
    history = []
    previous = None
    process = subprocess.Popen(args, stdout=stream, stderr=subprocess.STDOUT, **kwargs)
    link_down = False
    routes = {}
    addresses = []
    def link(state):
        nonlocal addresses
        if not network_exec:
            raise ValueError("owned client network context is required")
        policy = json.loads((output / "policy.json").read_text())
        actual = subprocess.check_output([*network_exec, "readlink", "/proc/self/ns/net"], text=True).strip()
        if actual != policy["networkNamespace"]:
            raise ValueError("network context does not match the installed policy")
        if state == "down":
            addresses = json.loads(subprocess.check_output([*network_exec, "ip", "-json", "address", "show", "dev", interface], text=True))[0]["addr_info"]
            for family in ("-4", "-6"):
                routes[family] = json.loads(subprocess.check_output([*network_exec, "ip", "-json", family, "route", "show", "default"], text=True))
        subprocess.run([*network_exec, "ip", "link", "set", interface, state], check=True, capture_output=True)
        if state == "up":
            for address in addresses:
                if address.get("scope") != "global": continue
                family = "-6" if address["family"] == "inet6" else "-4"
                invocation = [*network_exec, "ip", family, "address", "replace", f'{address["local"]}/{address["prefixlen"]}', "dev", interface]
                if family == "-6": invocation.append("nodad")
                subprocess.run(invocation, check=True, capture_output=True)
            # Linux removes IPv6 default routes on link-down. Restore the exact
            # task-owned route so this is a recoverable network fault.
            for family, entries in routes.items():
                for route in entries:
                    if route.get("dev") != interface or not route.get("gateway"):
                        raise ValueError("unexpected default route in the owned namespace")
                    subprocess.run([*network_exec, "ip", family, "route", "replace", "default", "via", route["gateway"], "dev", interface], check=True, capture_output=True)
    try:
        while process.poll() is None:
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
                        fds = subprocess.check_output(["docker", "exec", "--privileged", "-u", "0", turn, "ls", "-l", "/proc/1/fd"], text=True, stderr=subprocess.STDOUT)
                        inodes = set(re.findall(r"socket:\[(\d+)\]", fds))
                        udp = subprocess.check_output(["docker", "exec", "--privileged", "-u", "0", turn, "cat", "/proc/net/udp", "/proc/net/udp6"], text=True, stderr=subprocess.STDOUT)
                        allocated = sorted({line.split()[9] for line in udp.splitlines() if len(line.split()) > 9 and line.split()[9] in inodes and
                                            relay_range[0] <= int(line.split()[1].split(":")[-1], 16) <= relay_range[1]})
                        result = {"id": previous, "action": action, "ok": True, "ownedRelaySockets": len(allocated), "relaySocketIds": allocated, "at": time.time()}
                    except subprocess.CalledProcessError as error:
                        result = {"id": previous, "ok": False, "error": str(error)}
                elif action not in ("pause", "unpause", "restart"):
                    result = {"id": previous, "ok": False, "error": "unsupported TURN test action"}
                else:
                    run = subprocess.run(["docker", action, turn], capture_output=True, text=True)
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
            except (OSError, ValueError, subprocess.CalledProcessError):
                pass  # The supervised launcher may already have deleted its namespace.
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
        subprocess.run(["docker", "unpause", turn], capture_output=True)
        (output / "turn-control.json").write_text(json.dumps(history, indent=2) + "\n")
