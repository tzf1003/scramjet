#!/usr/bin/env python3
"""Fault injection tests; run only in a disposable Linux network namespace."""
import json
import os
from pathlib import Path
import socket
import subprocess
import threading

ROOT = Path(__file__).parent


def run(script, env, success=True):
    result = subprocess.run(["python3", str(ROOT / script)], env=env, capture_output=True, text=True)
    assert (result.returncode == 0) == success, (script, result.stdout, result.stderr)
    if script == "policy.py" and success:
        # Only this test hosts its authorized listener in the client namespace.
        # Real browser deployments keep services outside that namespace.
        subprocess.run(["nft", "insert", "rule", "inet", "scramjet_webrtc", "output", "ip", "saddr", "127.0.0.1", "tcp", "sport", "19000", "accept"], check=True)
    return result


def tcp_listener(number):
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", number))
    server.listen()
    def serve():
        while True:
            try:
                peer, _ = server.accept()
                peer.close()
            except OSError:
                break
    threading.Thread(target=serve, daemon=True).start()
    return server


def main():
    env = dict(os.environ, SCRAMJET_HOST="127.0.0.1", SCRAMJET_PORT="19000", TURN_HOST="127.0.0.1",
               TURN_PORT="19000", ALLOW_LOOPBACK="0", UNAUTHORIZED_UDP_TARGET="127.0.0.1:19002",
               UNAUTHORIZED_TCP_URL="http://127.0.0.1:19001/")
    authorized = tcp_listener(19000)
    unauthorized = tcp_listener(19001)
    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    udp.bind(("127.0.0.1", 19002))
    def echo():
        while True:
            try:
                data, addr = udp.recvfrom(4096)
                udp.sendto(data, addr)
            except OSError:
                break
    threading.Thread(target=echo, daemon=True).start()
    try:
        # The same endpoints really are reachable before policy installation.
        socket.create_connection(("127.0.0.1", 19001), timeout=1).close()
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.settimeout(1); probe.sendto(b"control", ("127.0.0.1", 19002))
            assert probe.recv(4096) == b"control"
        run("policy.py", env)
        run("verify.py", env)
        invalid = dict(env, TURN_HOST="invalid-address")
        run("policy.py", invalid, False)
        run("verify.py", env)
        subprocess.run(["nft", "insert", "rule", "inet", "scramjet_webrtc", "output", "ip", "daddr", "127.0.0.1", "tcp", "dport", "19001", "accept"], check=True)
        subprocess.run(["nft", "insert", "rule", "inet", "scramjet_webrtc", "output", "ip", "saddr", "127.0.0.1", "tcp", "sport", "19001", "accept"], check=True)
        run("verify.py", env, False)
        run("policy.py", env)
        subprocess.run(["nft", "insert", "rule", "inet", "scramjet_webrtc", "output", "ip", "daddr", "127.0.0.1", "udp", "dport", "19002", "accept"], check=True)
        subprocess.run(["nft", "insert", "rule", "inet", "scramjet_webrtc", "output", "ip", "saddr", "127.0.0.1", "udp", "sport", "19002", "accept"], check=True)
        run("verify.py", env, False)
        print(json.dumps({"atomicReload": True, "tcpFalsePositiveRejected": True,
                          "udpFalsePositiveRejected": True, "reachableControls": True, "ok": True}))
    finally:
        authorized.close(); unauthorized.close(); udp.close()


if __name__ == "__main__":
    main()
