#!/usr/bin/env python3
"""Test real authenticated TURN permission ACLs in an offline Docker stack."""
import argparse
import base64
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import secrets
import socket
import struct
import subprocess
import time

ROOT = Path(__file__).resolve().parents[3]
TURN_IMAGE = "coturn/coturn:4.18.0-r0@sha256:bbefd3e1fdfdc0d58770fe01b581fd8b00d9f3a5580d00acb77cf719a6bc78e3"
COOKIE = 0x2112A442


def attribute(kind, value):
    return struct.pack("!HH", kind, len(value)) + value + bytes((-len(value)) % 4)


def exchange(sock, method, attributes, auth=None, peer=None):
    transaction = secrets.token_bytes(12)
    body = b"".join(attributes)
    if peer is not None:
        address = ipaddress.ip_address(peer)
        mask = struct.pack("!I", COOKIE) + transaction
        encoded = bytes(value ^ mask[index] for index, value in enumerate(address.packed))
        value = b"\0" + bytes([1 if address.version == 4 else 2]) + struct.pack("!H", 9 ^ (COOKIE >> 16)) + encoded
        body += attribute(0x0012, value)
    if auth is not None:
        username, realm, nonce, key = auth
        body += attribute(0x0006, username) + attribute(0x0014, realm) + attribute(0x0015, nonce)
        header = struct.pack("!HHI12s", method, len(body) + 24, COOKIE, transaction)
        body += attribute(0x0008, hmac.new(key, header + body, hashlib.sha1).digest())
    sock.send(struct.pack("!HHI12s", method, len(body), COOKIE, transaction) + body)
    while True:
        response = sock.recv(65535)
        assert len(response) >= 20, "short STUN response"
        kind, length, cookie, received = struct.unpack("!HHI12s", response[:20])
        if received != transaction:
            continue
        assert cookie == COOKIE and len(response) == 20 + length, "invalid STUN header"
        parsed, offset = {}, 20
        while offset < len(response):
            tag, size = struct.unpack("!HH", response[offset:offset + 4])
            value = response[offset + 4:offset + 4 + size]
            assert len(value) == size, "short STUN attribute"
            if tag == 0x0008 and auth is not None:
                signed_header = struct.pack("!HHI12s", kind, offset + 24 - 20, COOKIE, transaction)
                expected = hmac.new(auth[3], signed_header + response[20:offset], hashlib.sha1).digest()
                assert hmac.compare_digest(value, expected), "invalid response integrity"
            parsed[tag] = value
            offset += 4 + size + (-size) % 4
        error = parsed.get(0x0009)
        code = (error[2] & 7) * 100 + error[3] if error else None
        if auth is not None:
            assert 0x0008 in parsed, "authenticated response lacks integrity"
        return kind, parsed, code


def probe(secret):
    username = f"{int(time.time()) + 120}:acl-probe".encode()
    password = base64.b64encode(hmac.new(secret.encode(), username, hashlib.sha1).digest())
    cases = {
        4: [("8.8.8.8", True), ("127.0.0.1", False), ("10.1.2.3", False),
            ("100.100.100.200", False), ("169.254.169.254", False),
            ("172.16.1.1", False), ("192.168.1.1", False), ("224.0.0.1", False)],
        6: [("2606:4700:4700::1111", True), ("::1", False), ("fd00::1", False),
            ("fe80::1", False), ("ff02::1", False), ("::ffff:127.0.0.1", False),
            ("::ffff:169.254.169.254", False), ("::", False),
            ("64:ff9b::7f00:1", False), ("64:ff9b::a9fe:a9fe", False)],
    }
    results = []
    for family, peers in cases.items():
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(4)
            sock.connect(("198.18.0.1", 3478))
            allocation = [attribute(0x0019, b"\x11\0\0\0"),
                          attribute(0x0017, bytes([1 if family == 4 else 2, 0, 0, 0]))]
            _, challenge, code = exchange(sock, 0x0003, allocation)
            assert code == 401, f"allocation must require authentication: {code}"
            realm, nonce = challenge[0x0014], challenge[0x0015]
            key = hashlib.md5(username + b":" + realm + b":" + password).digest()
            auth = (username, realm, nonce, key)
            kind, allocated, code = exchange(sock, 0x0003, allocation, auth)
            assert kind == 0x0103, f"IPv{family} authenticated allocation failed: {code}"
            assert allocated[0x0016][1] == (1 if family == 4 else 2), "allocation family mismatch"
            for peer, allowed in peers:
                channel = 0x4000 + len(results)
                for method, attributes, label in [
                    (0x0008, [], "CreatePermission"),
                    (0x0009, [attribute(0x000C, struct.pack("!HH", channel, 0))], "ChannelBind"),
                ]:
                    kind, _, code = exchange(sock, method, attributes, auth, peer)
                    ok = kind == (method | (0x0100 if allowed else 0x0110)) and code == (None if allowed else 403)
                    results.append({"allocationFamily": family, "method": label, "peer": peer,
                                    "expected": "allow" if allowed else "deny",
                                    "errorCode": code, "ok": ok})
            kind, _, _ = exchange(sock, 0x0004, [attribute(0x000D, struct.pack("!I", 0))], auth)
            assert kind == 0x0104, "allocation cleanup failed"
    print(json.dumps({"cases": results, "ok": all(case["ok"] for case in results)}, indent=2))
    return 0 if all(case["ok"] for case in results) else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="scramjet-webrtc-linux-verification:local")
    parser.add_argument("--output", type=Path, help="Write the credential-free JSON receipt")
    parser.add_argument("--probe", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.probe:
        return probe(os.environ["TURN_STATIC_AUTH_SECRET"])
    name = "sj-turn-acl-" + secrets.token_hex(5)
    secret = secrets.token_hex(32)
    turn_env = dict(os.environ, TURN_STATIC_AUTH_SECRET=secret)
    owned = []
    def run(*command):
        return subprocess.run(command, env=turn_env, check=True, capture_output=True, text=True)
    try:
        run("docker", "run", "-d", "--name", name, "--network", "none", "--cap-add", "NET_ADMIN",
            "-v", f"{ROOT}:{ROOT}:ro", "--entrypoint", "sleep", args.image, "infinity")
        owned.append(name)
        for command in [("ip", "link", "add", "aclnet", "type", "dummy"),
                        ("ip", "addr", "add", "198.18.0.1/24", "dev", "aclnet"),
                        ("ip", "-6", "addr", "add", "2001:db8::1/64", "dev", "aclnet", "nodad"),
                        ("ip", "link", "set", "aclnet", "up")]:
            run("docker", "exec", name, *command)
        run("docker", "run", "-d", "--name", name + "-turn", "--network", "container:" + name,
            "-v", f"{ROOT}/tests/webrtc/coturn:/etc/coturn:ro", "--env", "TURN_STATIC_AUTH_SECRET",
            "--entrypoint", "/bin/sh", TURN_IMAGE, "-c",
            'exec turnserver -c /etc/coturn/turnserver.conf --static-auth-secret="$TURN_STATIC_AUTH_SECRET" "$@"', "sh",
            "--listening-ip=198.18.0.1", "--relay-ip=198.18.0.1", "--relay-ip=2001:db8::1", "--log-file=stdout")
        owned.append(name + "-turn")
        for _ in range(50):
            ready = subprocess.run(["docker", "exec", name, "python3", "-c",
                                    "import socket;s=socket.create_connection(('198.18.0.1',3478),.2);s.close()"], capture_output=True)
            if ready.returncode == 0:
                break
            time.sleep(.1)
        else:
            raise RuntimeError("Coturn listener did not become ready")
        result = subprocess.run(["docker", "exec", "--env", "TURN_STATIC_AUTH_SECRET", name,
                                 "python3", str(Path(__file__).resolve()), "--probe"], env=turn_env, capture_output=True, text=True)
        if result.stdout:
            receipt = json.loads(result.stdout)
            receipt.update(turnImage=TURN_IMAGE, topology="offline-container-network", runId=name,
                           scriptSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                           configurationSha256=hashlib.sha256((ROOT / "tests/webrtc/coturn/turnserver.conf").read_bytes()).hexdigest())
            encoded = json.dumps(receipt, indent=2) + "\n"
            if args.output:
                args.output.parent.mkdir(parents=True, exist_ok=True)
                args.output.write_text(encoded)
            print(json.dumps({"cases": len(receipt["cases"]), "ok": receipt["ok"],
                              "output": str(args.output) if args.output else None}))
        if result.returncode:
            print(result.stderr, end="")
            logs = subprocess.run(["docker", "logs", name + "-turn"], capture_output=True, text=True)
            print("\n".join((logs.stdout + logs.stderr).replace(secret, "[REDACTED_SECRET]").splitlines()[-80:]))
        return result.returncode
    finally:
        for container in reversed(owned):
            subprocess.run(["docker", "rm", "-f", container], capture_output=True)


if __name__ == "__main__":
    raise SystemExit(main())
