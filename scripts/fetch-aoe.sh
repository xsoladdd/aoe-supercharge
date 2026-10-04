#!/usr/bin/env bash
# Download an AoE release binary for this runner and install it as ./.aoe-bin/aoe.
# Usage: scripts/fetch-aoe.sh <version>   (prints the binary path)
# The binary is renamed to `aoe`: AoE 1.18+ only recognises its own daemon under that name.
set -euo pipefail
version="$1"
case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) echo "unsupported OS" >&2; exit 1 ;; esac
case "$(uname -m)" in arm64 | aarch64) arch=arm64 ;; x86_64 | amd64) arch=amd64 ;; *) echo "unsupported arch" >&2; exit 1 ;; esac
asset="aoe-${os}-${arch}.tar.gz"
base="https://github.com/agent-of-empires/agent-of-empires/releases/download/v${version}"
dir="$(pwd)/.aoe-bin"
rm -rf "$dir" && mkdir -p "$dir"
curl -fsSL -o "$dir/$asset" "$base/$asset"
curl -fsSL -o "$dir/$asset.sha256" "$base/$asset.sha256"
expected="$(awk '{print $1}' "$dir/$asset.sha256")"
if command -v sha256sum >/dev/null; then actual="$(sha256sum "$dir/$asset" | awk '{print $1}')"; else actual="$(shasum -a 256 "$dir/$asset" | awk '{print $1}')"; fi
[ "$expected" = "$actual" ] || { echo "checksum mismatch for $asset" >&2; exit 1; }
tar -xzf "$dir/$asset" -C "$dir"
bin="$(find "$dir" -type f \( -name aoe -o -name "aoe-${os}-${arch}" \) | head -1)"
mv "$bin" "$dir/aoe" 2>/dev/null || true
chmod +x "$dir/aoe"
echo "$dir/aoe"
