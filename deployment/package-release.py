"""Assemble a gateway release from an existing server layout and a Vite build."""
from pathlib import Path
import argparse
import hashlib
import io
import ipaddress
import json
import re
import shutil
import subprocess
import tarfile

parser = argparse.ArgumentParser()
parser.add_argument('--base', type=Path, required=True)
parser.add_argument('--frontend', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--release-id', required=True)
parser.add_argument('--trusted-proxy-ip', help='Fixed gateway container IP; its edge must overwrite X-Real-IP')
parser.add_argument('--proxy-domain', help='Base domain for mapped target hosts, optionally prefixed with *.')
parser.add_argument('--gateway-host', help='Portal hostname within the proxy domain')
args = parser.parse_args()

def hostname(value):
    value = value.strip().lower().removeprefix('*.').removesuffix('.')
    if len(value) > 253 or not all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label) for label in value.split('.')):
        raise SystemExit('Expected a valid DNS hostname')
    return value

if args.gateway_host and not args.proxy_domain:
    raise SystemExit('--gateway-host requires --proxy-domain')
if args.proxy_domain:
    args.proxy_domain = hostname(args.proxy_domain)
    args.gateway_host = hostname(args.gateway_host or args.proxy_domain)
    if args.gateway_host != args.proxy_domain and not args.gateway_host.endswith('.' + args.proxy_domain):
        raise SystemExit('Gateway host must belong to the proxy domain')
repo = Path(__file__).resolve().parent.parent
output = args.output.resolve()
if output.exists():
    raise SystemExit('Use a new release output directory')
output.mkdir(parents=True)
release = output / 'release'
release.mkdir()
revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
for name in ['compose.yaml', 'nginx.conf']:
    shutil.copy2(args.base / name, release / name)
shutil.copytree(args.base / 'coturn', release / 'coturn', ignore=shutil.ignore_patterns('._*'))
shutil.copytree(args.frontend, release / 'public', ignore=shutil.ignore_patterns('._*'))
for name in ['app.mjs', 'access-key.mjs', 'client-ip.mjs', 'credential-server.mjs', 'Dockerfile', 'package.json', 'package-lock.json']:
    shutil.copy2(repo / 'deployment' / name, release / name)
for source in (repo / 'deployment/public').iterdir():
    if source.is_file() and not source.name.startswith('._'):
        shutil.copy2(source, release / 'public' / source.name)
index = release / 'public/index.html'
index.write_text(index.read_text().replace('</head>', '<script type="module" src="/access-session.js"></script></head>'))
compose = (release / 'compose.yaml').read_text()
compose = re.sub(r'image: scramjet-local:[^\s]+', 'image: scramjet-local:' + args.release_id, compose)
compose = re.sub(r'SOURCE_COMMIT: [^\s]+', 'SOURCE_COMMIT: ' + revision, compose)
if args.proxy_domain:
    compose, count = re.subn(r'^      PROXY_DOMAIN:.*$', '      PROXY_DOMAIN: ' + args.proxy_domain, compose, flags=re.M)
    if count != 1:
        raise SystemExit('Expected one app PROXY_DOMAIN setting')
    compose = re.sub(r'^      GATEWAY_HOST:.*\n', '', compose, flags=re.M)
    compose = compose.replace('      PROXY_DOMAIN: ' + args.proxy_domain + '\n', '      PROXY_DOMAIN: ' + args.proxy_domain + '\n      GATEWAY_HOST: ' + args.gateway_host + '\n', 1)
    nginx = (release / 'nginx.conf').read_text()
    nginx, count = re.subn(r'(?m)^(\s*server_name)\s+[^;]+;', r'\g<1> .' + args.proxy_domain + ';', nginx)
    if count != 1:
        raise SystemExit('Expected one gateway server_name setting')
    (release / 'nginx.conf').write_text(nginx)
compose = re.sub(r'^      ACCESS_KEY_FILE:.*\n', '', compose, flags=re.M)
compose = compose.replace('      SOURCE_COMMIT: ' + revision, '      SOURCE_COMMIT: ' + revision + '\n      ACCESS_KEY_FILE: /run/secrets/access-key')
compose = re.sub(r'^      TRUSTED_PROXY_CIDRS:.*\n', '', compose, flags=re.M)
if args.trusted_proxy_ip:
    address = ipaddress.ip_address(args.trusted_proxy_ip)
    if address.version != 4:
        raise SystemExit('The web network requires an IPv4 gateway address')
    compose = compose.replace('      ACCESS_KEY_FILE:', f'      TRUSTED_PROXY_CIDRS: {address}/32\n      ACCESS_KEY_FILE:')
    gateway, separator, rest = compose.partition('  gateway:\n')
    if not separator:
        raise SystemExit('Expected a gateway service on the web network')
    if '    networks: [web]' in rest:
        rest = rest.replace('    networks: [web]', f'    networks:\n      web:\n        ipv4_address: {address}', 1)
    elif re.search(r'^        ipv4_address: \S+$', rest, re.M):
        rest = re.sub(r'^        ipv4_address: \S+$', f'        ipv4_address: {address}', rest, count=1, flags=re.M)
    else:
        raise SystemExit('Expected a gateway service on the web network')
    compose = gateway + separator + rest
compose = compose.replace('/opt/scramjet/secrets/admin-password.txt:/run/secrets/admin-password:ro', '/opt/scramjet/secrets/access-key.txt:/run/secrets/access-key:ro')
(release / 'compose.yaml').write_text(compose)
(release / 'public/version.json').write_text(json.dumps({'revision': revision, 'release': args.release_id, 'access': 'persistent-key', 'mode': 'relay'}, indent=2) + '\n')

def portable(info):
    info.uid = info.gid = 0
    info.uname = info.gname = 'root'
    info.mode = 0o755 if info.isdir() else 0o644
    return info

source = subprocess.check_output(['git', 'archive', '--format=tar', 'HEAD'], cwd=repo)
with tarfile.open(fileobj=io.BytesIO(source)) as base, tarfile.open(release / 'public/source.tar.gz', 'w:gz') as tar:
    for info in base:
        tar.addfile(info, base.extractfile(info) if info.isfile() else None)
    # The final entries contain the exact source used by this local release.
    paths = ['deployment', 'packages/demo/src', 'packages/demo/index.html', 'packages/demo/.env.example', 'tests/deployment']
    for item in paths:
        p = repo / item
        for file in ([p] if p.is_file() else sorted(p.rglob('*'))):
            if file.is_file() and 'node_modules' not in file.parts and not file.name.startswith('._'):
                tar.add(file, arcname=str(file.relative_to(repo)), filter=portable)
manifest = {str(p.relative_to(release)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(release.rglob('*')) if p.is_file()}
(output / 'sha256.json').write_text(json.dumps(manifest, indent=2) + '\n')
with tarfile.open(output / 'release.tar.gz', 'w:gz') as tar:
    for item in release.iterdir():
        tar.add(item, arcname=item.name, filter=portable)
print(json.dumps({'release': args.release_id, 'files': len(manifest), 'archive': str(output / 'release.tar.gz')}))
