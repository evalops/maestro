#!/usr/bin/env bash
set -euo pipefail
REPO="evalops/maestro"
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
for cmd in uname curl mktemp chmod mkdir tar; do command -v "$cmd" >/dev/null || fail "Required command not found: $cmd"; done
case "$(uname -s)" in Darwin) os=darwin;; Linux) os=linux;; *) fail "Unsupported OS: $(uname -s)";; esac
case "$(uname -m)" in x86_64|amd64) arch=x64;; arm64|aarch64) arch=arm64;; *) fail "Unsupported architecture: $(uname -m)";; esac
platform="${os}-${arch}"
case "$platform" in darwin-arm64|darwin-x64|linux-x64|linux-arm64);; *) fail "Unsupported platform: $platform";; esac
asset="maestro-${platform}"
web_asset="maestro-web-dist.tar.gz"
if [[ -n "${MAESTRO_VERSION:-}" ]]; then release_url="https://github.com/${REPO}/releases/download/v${MAESTRO_VERSION#v}"; else release_url="https://github.com/${REPO}/releases/latest/download"; fi
url="${release_url}/${asset}"
install_dir="${MAESTRO_INSTALL_DIR:-${HOME}/.local/bin}"
tmpdir="$(mktemp -d 2>/dev/null || mktemp -d -t maestro-install)"
trap 'rm -rf "$tmpdir"' EXIT
printf 'Downloading %s...\n' "$asset" >&2
curl -fsSL --proto '=https' --tlsv1.2 -o "$tmpdir/$asset" "$url" || fail "Download failed: $url"
printf 'Downloading %s...\n' "$web_asset" >&2
curl -fsSL --proto '=https' --tlsv1.2 -o "$tmpdir/$web_asset" "${release_url}/${web_asset}" || fail "Download failed: ${release_url}/${web_asset}"
chmod 755 "$tmpdir/$asset"
mkdir -p "$tmpdir/maestro-web"
tar -xzf "$tmpdir/$web_asset" -C "$tmpdir/maestro-web"
[[ -f "$tmpdir/maestro-web/index.html" ]] || fail "$web_asset does not contain index.html"
mkdir -p "$install_dir"
stage="$install_dir/maestro.install.$$"
cp "$tmpdir/$asset" "$stage" && chmod 755 "$stage" && mv -f "$stage" "$install_dir/maestro"
web_stage="$install_dir/maestro-web.install.$$"
mv "$tmpdir/maestro-web" "$web_stage"
rm -rf "$install_dir/maestro-web"
mv "$web_stage" "$install_dir/maestro-web"
printf 'Installed native Maestro to %s\n' "$install_dir/maestro" >&2
"$install_dir/maestro" --version
