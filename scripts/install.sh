#!/usr/bin/env bash
#
# Maestro one-line installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/evalops/maestro/main/scripts/install.sh | bash
#
# Optional env:
#   MAESTRO_INSTALL_DIR  Install directory (default: $HOME/.local/bin, or
#                        /usr/local/bin when writable and preferred)
#   MAESTRO_VERSION      Release tag without leading v (default: latest)
#
# Installs both `maestro` (JS/Bun launcher) and `maestro-tui` (native agent UI +
# web/headless default). Override TUI resolution later with MAESTRO_TUI_BIN.
#
set -euo pipefail

REPO="evalops/maestro"
RELEASES_BASE="https://github.com/${REPO}/releases"
RAW_INSTALL_URL="https://raw.githubusercontent.com/evalops/maestro/main/scripts/install.sh"

info() { printf '%s\n' "$*" >&2; }
err() { printf 'Error: %s\n' "$*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || err "Required command not found: $1"
}

need_cmd uname
need_cmd curl
need_cmd mktemp
need_cmd chmod
need_cmd mkdir

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"

case "$os" in
  darwin) os_label="darwin" ;;
  linux) os_label="linux" ;;
  *)
    err "Unsupported OS: $(uname -s). Maestro release binaries currently target macOS and Linux.
On Windows, use npm/Bun or GitHub release assets — see ${RAW_INSTALL_URL%/*}/install.ps1"
    ;;
esac

case "$arch" in
  x86_64 | amd64) arch_label="x64" ;;
  arm64 | aarch64) arch_label="arm64" ;;
  *)
    err "Unsupported architecture: $arch (supported: x86_64/amd64, arm64/aarch64)"
    ;;
esac

platform="${os_label}-${arch_label}"
asset="maestro-${platform}"
# Native agent UI + web/headless default; published alongside maestro in releases.
tui_asset="maestro-tui-${platform}"

case "$platform" in
  darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64) ;;
  *)
    err "Unsupported platform: $platform
Supported platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64"
    ;;
esac

if [ -n "${MAESTRO_VERSION:-}" ]; then
  version="${MAESTRO_VERSION#v}"
  download_url="${RELEASES_BASE}/download/v${version}/${asset}"
  tui_download_url="${RELEASES_BASE}/download/v${version}/${tui_asset}"
  version_label="v${version}"
else
  download_url="${RELEASES_BASE}/latest/download/${asset}"
  tui_download_url="${RELEASES_BASE}/latest/download/${tui_asset}"
  version_label="latest"
fi

# Prefer an explicit install dir; otherwise ~/.local/bin. Use /usr/local/bin
# when it is writable and either preferred or already on PATH without ~/.local/bin.
path_has_dir() {
  case ":${PATH}:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

if [ -n "${MAESTRO_INSTALL_DIR:-}" ]; then
  install_dir="${MAESTRO_INSTALL_DIR}"
elif [ "${MAESTRO_PREFER_USR_LOCAL:-}" = "1" ] && [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
  install_dir="/usr/local/bin"
elif path_has_dir "/usr/local/bin" \
  && [ -d /usr/local/bin ] \
  && [ -w /usr/local/bin ] \
  && ! path_has_dir "${HOME}/.local/bin" \
  && [ ! -d "${HOME}/.local/bin" ]; then
  install_dir="/usr/local/bin"
else
  install_dir="${HOME}/.local/bin"
fi

install_path="${install_dir}/maestro"
tui_install_path="${install_dir}/maestro-tui"

info "Maestro installer"
info "  Platform : ${platform}"
info "  Version  : ${version_label}"
info "  Target   : ${install_path}"
info "  TUI      : ${tui_install_path}"
info "  URL      : ${download_url}"
info "  TUI URL  : ${tui_download_url}"

tmpdir="$(mktemp -d 2>/dev/null || mktemp -d -t maestro-install)"
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT

tmp_bin="${tmpdir}/${asset}"
tmp_tui="${tmpdir}/${tui_asset}"

download_release_asset() {
  # $1 = label, $2 = dest path, $3 = url, $4 = asset name
  local label="$1"
  local dest="$2"
  local url="$3"
  local name="$4"
  info "Downloading ${name}..."
  if ! curl -fsSL --proto '=https' --tlsv1.2 -o "${dest}" "${url}"; then
    err "Download failed for ${url}
Check that a release asset named '${name}' exists at:
  https://github.com/${REPO}/releases
Supported assets include maestro-*/maestro-tui-* for darwin-arm64, darwin-x64, linux-x64, linux-arm64"
  fi
  if [ ! -s "${dest}" ]; then
    err "Downloaded file is empty: ${url}"
  fi
  # Reject obvious HTML error pages (common when a platform asset is missing).
  if head -c 15 "${dest}" | grep -qi '<!DOCTYPE\|<html'; then
    err "Download returned HTML instead of a binary for ${label} on platform '${platform}'.
This usually means the '${name}' release asset is not published yet.
See https://github.com/${REPO}/releases"
  fi
  chmod +x "${dest}"
}

download_release_asset "maestro" "${tmp_bin}" "${download_url}" "${asset}"
download_release_asset "maestro-tui" "${tmp_tui}" "${tui_download_url}" "${tui_asset}"

mkdir -p "${install_dir}"

# Atomic-ish replace: write temp then mv into place.
install_binary() {
  local src="$1"
  local dest="$2"
  local stage="${dest}.install.$$"
  cp "${src}" "${stage}"
  chmod 755 "${stage}"
  mv -f "${stage}" "${dest}"
}

install_binary "${tmp_bin}" "${install_path}"
install_binary "${tmp_tui}" "${tui_install_path}"

info "Installed maestro to ${install_path}"
info "Installed maestro-tui to ${tui_install_path}"

if ! path_has_dir "${install_dir}"; then
  info ""
  info "Note: ${install_dir} is not on your PATH."
  info "Add it for this shell:"
  info "  export PATH=\"${install_dir}:\$PATH\""
  info ""
  info "Or add that line to your shell profile (~/.zshrc, ~/.bashrc, etc.)."
  export PATH="${install_dir}:${PATH}"
fi

if command -v maestro >/dev/null 2>&1; then
  info ""
  info "Verifying installation..."
  if maestro --version; then
    info ""
    info "Done. Run 'maestro' to start, 'maestro web' for the browser UI, or 'maestro codex login' to authenticate."
    info "Native TUI/web chat needs maestro-tui (installed next to maestro, or set MAESTRO_TUI_BIN)."
  else
    info "Installed binary could not run 'maestro --version'."
    info "Try: ${install_path} --version"
  fi
else
  info ""
  info "Binaries installed at ${install_path} and ${tui_install_path}"
  info "Run: ${install_path} --version"
fi
