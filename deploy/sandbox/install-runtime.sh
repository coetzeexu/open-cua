#!/usr/bin/env bash
# Install pinned tools in a private directory; do not replace the image's system Node.
set -euo pipefail
case "$(uname -s):$(uname -m)" in
  Linux:x86_64) cua_arch=x64 ;;
  Linux:aarch64) cua_arch=arm64 ;;
  *) echo 'Supported runtime target: Linux x64/arm64 (glibc).' >&2; exit 1 ;;
esac
cua_runtime_dir="${CUA_RUNTIME_DIR:-$HOME/.local/share/cua-runtime}"
mkdir -p "$cua_runtime_dir"
cua_download_dir="$(mktemp -d)"
trap 'rm -rf "$cua_download_dir"' EXIT
cua_node_archive="node-v24.18.0-linux-$cua_arch.tar.xz"
curl --fail --silent --show-error --location --connect-timeout 15 --max-time 180 --retry 3 "https://nodejs.org/dist/v24.18.0/$cua_node_archive" -o "$cua_download_dir/$cua_node_archive"
curl --fail --silent --show-error --location --connect-timeout 15 --max-time 180 --retry 3 https://nodejs.org/dist/v24.18.0/SHASUMS256.txt -o "$cua_download_dir/SHASUMS256.txt"
(cd "$cua_download_dir"; awk -v name="$cua_node_archive" '$2 == name' SHASUMS256.txt > node.sha256; test -s node.sha256; sha256sum -c node.sha256)
mkdir -p "$cua_runtime_dir/node"
tar -xJf "$cua_download_dir/$cua_node_archive" --strip-components=1 -C "$cua_runtime_dir/node"
# Bun's official npm binary package has a registry-provided SHA512 integrity hash.
python3 - "$cua_arch" "$cua_download_dir" "$cua_runtime_dir" <<'PY'
import sys, json, urllib.request, hashlib, base64, tarfile, pathlib
arch, tmp, target = sys.argv[1:]
bun_arch = 'aarch64' if arch == 'arm64' else arch
meta = json.load(urllib.request.urlopen(f'https://registry.npmjs.org/@oven/bun-linux-{bun_arch}/1.3.12', timeout=60))
data = urllib.request.urlopen(meta['dist']['tarball'], timeout=120).read()
actual = 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode()
if actual != meta['dist']['integrity']: raise SystemExit('Bun integrity mismatch')
archive = pathlib.Path(tmp) / 'bun.tgz'
archive.write_bytes(data)
with tarfile.open(archive) as tar:
    binary = tar.extractfile('package/bin/bun').read()
path = pathlib.Path(target) / 'bun' / 'bin' / 'bun'
path.parent.mkdir(parents=True, exist_ok=True)
path.write_bytes(binary)
path.chmod(0o755)
PY
"$cua_runtime_dir/node/bin/node" --version
"$cua_runtime_dir/bun/bin/bun" --version
printf 'Runtime ready. Add %s/node/bin and %s/bun/bin to PATH.\n' "$cua_runtime_dir" "$cua_runtime_dir"
