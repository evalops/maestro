#!/usr/bin/env bash
set -euo pipefail

REPO="${MAESTRO_RELEASE_REPO:-evalops/maestro}"
install_channel="${MAESTRO_INSTALL_CHANNEL:-stable}"
COSIGN_VERSION="2.6.1"
COSIGN_IDENTITY_REGEXP='^https://github.com/evalops/(maestro-internal|maestro)/\.github/workflows/release\.yml@'
COSIGN_OIDC_ISSUER="https://token.actions.githubusercontent.com"

fail() {
  printf 'Error: %s\n' "$*"
  exit 1
}

for cmd in uname curl mktemp chmod mkdir tar rm cp mv awk dirname basename date; do
  command -v "$cmd" >/dev/null || fail "Required command not found: $cmd"
done
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
  fail "Required command not found: sha256sum or shasum"
fi

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "Unsupported OS: $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) fail "Unsupported architecture: $(uname -m)" ;;
esac

platform="${os}-${arch}"
case "$platform" in
  darwin-arm64|darwin-x64|linux-x64|linux-arm64) ;;
  *) fail "Unsupported platform: $platform" ;;
esac

asset="maestro-${platform}"
web_asset="maestro-web-dist.tar.gz"
metadata_asset="release-metadata.json"
case "$platform" in
  darwin-x64)
    cosign_asset="cosign-darwin-amd64"
    cosign_sha256="f1ed2787cc9648fd3c644fcb279e43f3f55da63b788d69a527aa14ad97ffdca1"
    ;;
  darwin-arm64)
    cosign_asset="cosign-darwin-arm64"
    cosign_sha256="54047052cf46f40a5c3c95a510db276e164ba77e096aea1ca1b733f770359689"
    ;;
  linux-x64)
    cosign_asset="cosign-linux-amd64"
    cosign_sha256="064954c5d8c7e3b28188eee5b1727b31c411550bc5fefd41aa672d3c761d103a"
    ;;
  linux-arm64)
    cosign_asset="cosign-linux-arm64"
    cosign_sha256="56a16480bdd56ec789abaa65924402f6b92c0041f06885995853c05567b76f34"
    ;;
esac

case "$install_channel" in
  stable|beta|alpha) ;;
  *) fail "MAESTRO_INSTALL_CHANNEL must be stable, beta, or alpha" ;;
esac

if [[ -n "${MAESTRO_RELEASE_BASE_URL:-}" ]]; then
  release_url="${MAESTRO_RELEASE_BASE_URL%/}"
elif [[ -n "${MAESTRO_INSTALL_VERSION:-}" ]]; then
  release_url="https://github.com/${REPO}/releases/download/v${MAESTRO_INSTALL_VERSION#v}"
elif [[ "$install_channel" == "alpha" || "$install_channel" == "beta" ]]; then
  release_url="https://github.com/${REPO}/releases/download/maestro-${install_channel}-channel"
else
  release_url="https://github.com/${REPO}/releases/latest/download"
fi

install_dir="${MAESTRO_INSTALL_DIR:-$HOME/.local/bin}"
data_dir="${MAESTRO_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/maestro}"
allow_unsigned="${MAESTRO_ALLOW_UNSIGNED_INSTALL:-0}"
require_signed="${MAESTRO_REQUIRE_SIGNED_INSTALL:-0}"
case "$allow_unsigned" in
  0|false|no|"") ;;
  1|true|yes) ;;
  *) fail "MAESTRO_ALLOW_UNSIGNED_INSTALL must be 0 or 1" ;;
esac
case "$require_signed" in
  0|false|no|"") ;;
  1|true|yes) ;;
  *) fail "MAESTRO_REQUIRE_SIGNED_INSTALL must be 0 or 1" ;;
esac
if { [[ "$allow_unsigned" == "1" || "$allow_unsigned" == "true" || "$allow_unsigned" == "yes" ]]; } &&
  { [[ "$require_signed" == "1" || "$require_signed" == "true" || "$require_signed" == "yes" ]]; }; then
  fail "MAESTRO_REQUIRE_SIGNED_INSTALL cannot be combined with MAESTRO_ALLOW_UNSIGNED_INSTALL"
fi
mkdir -p "$data_dir" || fail "Could not create Maestro data directory: $data_dir"
data_dir="$(cd "$data_dir" 2>/dev/null && pwd -P)" ||
  fail "Could not resolve Maestro data directory: $data_dir"

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

receipt_hash_file() {
  printf 'sha256:%s' "$(hash_file "$1")"
}

curl_to() {
  local destination="$1"
  local url="$2"
  local -a options=(
    --fail
    --silent
    --show-error
    --location
    --max-time 180
    --retry 2
    --retry-delay 2
  )
  case "$url" in
    http://127.0.0.1:*|http://localhost:*) ;;
    *) options+=(--proto '=https' --tlsv1.2) ;;
  esac
  curl "${options[@]}" -o "$destination" "$url"
}

fetch_manifest() {
  local destination="$1"
  local url="$2"
  local status
  local -a options=(
    --silent
    --show-error
    --location
    --max-time 180
    --retry 2
    --retry-delay 2
    --write-out '%{http_code}'
  )
  case "$url" in
    http://127.0.0.1:*|http://localhost:*) ;;
    *) options+=(--proto '=https' --tlsv1.2) ;;
  esac
  if ! status="$(curl "${options[@]}" -o "$destination" "$url")"; then
    rm -f "$destination"
    fail "Checksum manifest request failed: $url"
  fi
  case "$status" in
    2??) return 0 ;;
    404)
      rm -f "$destination"
      return 1
      ;;
    *)
      rm -f "$destination"
      fail "Checksum manifest request returned HTTP $status: $url"
      ;;
  esac
}

download() {
  local url="$1"
  local destination="$2"
  local label="$3"
  printf 'Downloading %s...\n' "$label" >&2
  curl_to "$destination" "$url" ||
    fail "Download failed: $url"
}

verify_manifest_checksum() {
  local manifest="$1"
  local file="$2"
  local name="$3"
  local expected
  expected="$(awk -v name="$name" '$2 == name { value=$1; count++ } END { if (count != 1) exit 1; print value }' "$manifest")" ||
    fail "Checksum manifest does not contain exactly one entry for $name"
  local actual
  actual="$(hash_file "$file")"
  [[ "$actual" == "$expected" ]] ||
    fail "Checksum mismatch for $name"
}

verify_blob_signature() {
  local cosign="$1"
  local subject="$2"
  local bundle="$3"
  "$cosign" verify-blob \
    --bundle "$bundle" \
    --certificate-identity-regexp "$COSIGN_IDENTITY_REGEXP" \
    --certificate-oidc-issuer "$COSIGN_OIDC_ISSUER" \
    "$subject" >/dev/null ||
    fail "Signature verification failed for $(basename "$subject")"
}

shell_quote() {
  printf '%q' "$1"
}

tmpdir="$(mktemp -d 2>/dev/null || mktemp -d -t maestro-install)"
stage=""
launcher_stage=""
cleanup() {
  rm -rf "$tmpdir"
  if [[ -n "$stage" ]]; then
    rm -rf "$stage"
  fi
  if [[ -n "$launcher_stage" ]]; then
    rm -f "$launcher_stage"
  fi
}
trap cleanup EXIT

manifest="$tmpdir/SHA256SUMS"
manifest_available=0
manifest_sha256=""
signature_verified=0
metadata_checksum_verified=0
metadata_available=0
binary_checksum_verified=0
web_checksum_verified=0
if fetch_manifest "$manifest" "${release_url}/SHA256SUMS"; then
  manifest_available=1
  manifest_sha256="$(receipt_hash_file "$manifest")"
else
  if [[ "$require_signed" == "1" || "$require_signed" == "true" || "$require_signed" == "yes" ]]; then
    fail "Release has no SHA256SUMS manifest; refusing unsigned installation"
  fi
  printf 'Warning: release has no signed checksum manifest; installing in legacy unsigned mode.\n' >&2
fi

if [[ "$manifest_available" == "1" && "$allow_unsigned" != "1" && "$allow_unsigned" != "true" && "$allow_unsigned" != "yes" ]]; then
  download \
    "https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/${cosign_asset}" \
    "$tmpdir/cosign" \
    "Cosign ${COSIGN_VERSION}"
  actual_cosign_sha256="$(hash_file "$tmpdir/cosign")"
  [[ "$actual_cosign_sha256" == "$cosign_sha256" ]] ||
    fail "Cosign bootstrap checksum mismatch"
  chmod 755 "$tmpdir/cosign"
  download "${release_url}/SHA256SUMS.cosign.bundle" \
    "$tmpdir/SHA256SUMS.cosign.bundle" "SHA256SUMS signature"
  download "${release_url}/${asset}.cosign.bundle" \
    "$tmpdir/${asset}.cosign.bundle" "${asset} signature"
  verify_blob_signature "$tmpdir/cosign" "$manifest" "$tmpdir/SHA256SUMS.cosign.bundle"
  signature_verified=1
else
  if [[ "$manifest_available" == "1" ]]; then
    printf 'Warning: MAESTRO_ALLOW_UNSIGNED_INSTALL is enabled; skipping Cosign signature verification.\n' >&2
  fi
fi

metadata_manifest_entry=0
if [[ "$manifest_available" == "1" ]] &&
  awk -v name="$metadata_asset" '$2 == name { found=1 } END { exit !found }' "$manifest"; then
  metadata_manifest_entry=1
fi
if [[ "$metadata_manifest_entry" == "1" ]]; then
  download "${release_url}/${metadata_asset}" "$tmpdir/$metadata_asset" "$metadata_asset"
  verify_manifest_checksum "$manifest" "$tmpdir/$metadata_asset" "$metadata_asset"
  metadata_checksum_verified=1
  metadata_available=1
fi

if [[ "$manifest_available" == "1" && "$metadata_manifest_entry" == "0" ]]; then
  case "$require_signed" in
    1|true|yes)
      printf 'Warning: signed release has no %s; continuing with artifact verification and omitting optional release metadata.\n' "$metadata_asset" >&2
      ;;
  esac
fi

download "${release_url}/${asset}" "$tmpdir/$asset" "$asset"
download "${release_url}/${web_asset}" "$tmpdir/$web_asset" "$web_asset"
if [[ "$manifest_available" == "1" ]]; then
  verify_manifest_checksum "$manifest" "$tmpdir/$asset" "$asset"
  verify_manifest_checksum "$manifest" "$tmpdir/$web_asset" "$web_asset"
  binary_checksum_verified=1
  web_checksum_verified=1
  if [[ "$allow_unsigned" == "1" || "$allow_unsigned" == "true" || "$allow_unsigned" == "yes" ]]; then
    printf 'Checksum manifest verified; signature verification was explicitly bypassed.\n' >&2
  else
    verify_blob_signature "$tmpdir/cosign" "$tmpdir/$asset" "$tmpdir/${asset}.cosign.bundle"
  fi
fi

chmod 755 "$tmpdir/$asset"
mkdir -p "$tmpdir/maestro-web"
tar -xzf "$tmpdir/$web_asset" -C "$tmpdir/maestro-web"
[[ -f "$tmpdir/maestro-web/index.html" ]] || fail "$web_asset does not contain index.html"

if [[ -n "${MAESTRO_INSTALL_VERSION:-}" ]]; then
  release_version="${MAESTRO_INSTALL_VERSION#v}"
else
  version_output="$("$tmpdir/$asset" --version 2>/dev/null)" ||
    fail "Downloaded Maestro binary could not report its version"
  release_version="$(printf '%s\n' "$version_output" | awk 'NF {print $NF; exit}')"
fi
[[ "$release_version" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*$ ]] ||
  fail "Invalid release version: $release_version"

mkdir -p "$install_dir"
release_root="$data_dir/releases"
mkdir -p "$release_root"
stage="$(mktemp -d "$release_root/.staging.XXXXXX")" ||
  fail "Could not create release staging directory"
mkdir -p "$stage/bin"
cp "$tmpdir/$asset" "$stage/bin/maestro"
chmod 755 "$stage/bin/maestro"
mv "$tmpdir/maestro-web" "$stage/web"

release_version_root="$release_root/$release_version"
mkdir -p "$release_version_root"
"$stage/bin/maestro" --version >/dev/null ||
  fail "Staged Maestro binary failed its version check"
release_dir="$(mktemp -d "$release_version_root/${platform}.XXXXXX")" ||
  fail "Could not create release directory"
mv "$stage/bin" "$release_dir/bin"
mv "$stage/web" "$release_dir/web"
cp "$tmpdir/$web_asset" "$release_dir/$web_asset"
if [[ "$metadata_available" == "1" ]]; then
  cp "$tmpdir/$metadata_asset" "$release_dir/$metadata_asset"
fi
binary_receipt_sha256="$(receipt_hash_file "$release_dir/bin/maestro")"
web_receipt_sha256="$(receipt_hash_file "$tmpdir/$web_asset")"
metadata_receipt_sha256=""
if [[ "$metadata_available" == "1" ]]; then
  metadata_receipt_sha256="$(receipt_hash_file "$tmpdir/$metadata_asset")"
fi
installed_at_ms="$(( $(date +%s) * 1000 ))"
verified=0
if [[ "$signature_verified" == "1" && "$binary_checksum_verified" == "1" &&
  "$web_checksum_verified" == "1" ]]; then
  verified=1
fi
{
  printf '{\n'
  printf '  "schemaVersion": "evalops.maestro.install-receipt.v1",\n'
  printf '  "version": "%s",\n' "$release_version"
  printf '  "platform": "%s",\n' "$platform"
  printf '  "installedAtMs": %s,\n' "$installed_at_ms"
  printf '  "verified": %s,\n' "$([[ "$verified" == "1" ]] && printf true || printf false)"
  printf '  "verification": {\n'
  printf '    "manifestSha256": "%s",\n' "$manifest_sha256"
  printf '    "manifestChecksumVerified": %s,\n' "$([[ "$manifest_available" == "1" ]] && printf true || printf false)"
  printf '    "signatureVerified": %s,\n' "$([[ "$signature_verified" == "1" ]] && printf true || printf false)"
  printf '    "artifactSha256": "%s",\n' "$binary_receipt_sha256"
  printf '    "webSha256": "%s",\n' "$web_receipt_sha256"
  printf '    "metadataSha256": '
  if [[ "$metadata_available" == "1" ]]; then
    printf '"%s",\n' "$metadata_receipt_sha256"
  else
    printf 'null,\n'
  fi
  printf '    "metadataChecksumVerified": %s\n' "$([[ "$metadata_checksum_verified" == "1" ]] && printf true || printf false)"
  printf '  },\n'
  printf '  "releaseMetadataAsset": '
  if [[ "$metadata_available" == "1" ]]; then
    printf '"%s"\n' "$metadata_asset"
  else
    printf 'null\n'
  fi
  printf '}\n'
} > "$release_dir/install-receipt.json"
rm -rf "$stage"
stage=""

launcher_stage="$install_dir/.maestro.install.$$"
release_dir_quoted="$(shell_quote "$release_dir")"
install_dir_quoted="$(shell_quote "$install_dir")"
data_dir_quoted="$(shell_quote "$data_dir")"
release_version_quoted="$(shell_quote "$release_version")"
install_channel_quoted="$(shell_quote "$install_channel")"
{
  printf '%s\n' '#!/usr/bin/env bash' 'set -eu'
  printf 'release_dir=%s\n' "$release_dir_quoted"
	printf 'install_dir=%s\n' "$install_dir_quoted"
	printf 'data_dir=%s\n' "$data_dir_quoted"
	printf 'release_version=%s\n' "$release_version_quoted"
	printf 'install_channel=%s\n' "$install_channel_quoted"
	# These lines are intentionally literal: they are the generated launcher.
	# shellcheck disable=SC2016
	printf '%s\n' \
		'export MAESTRO_WEB_STATIC_ROOT="${MAESTRO_WEB_STATIC_ROOT:-$release_dir/web}"' \
		'export MAESTRO_INSTALL_METHOD=release' \
		'export MAESTRO_INSTALL_DIR="$install_dir"' \
		'export MAESTRO_DATA_DIR="$data_dir"' \
		'export MAESTRO_UPDATE_CHANNEL="${MAESTRO_UPDATE_CHANNEL:-$install_channel}"' \
		'export MAESTRO_STARTUP_UPDATE_STATE="${MAESTRO_STARTUP_UPDATE_STATE:-$data_dir/startup-update-state.json}"' \
		'export MAESTRO_VERSION="$release_version"'
	# shellcheck disable=SC2016
	printf '%s\n' 'exec "$release_dir/bin/maestro" "$@"'
} > "$launcher_stage"
chmod 755 "$launcher_stage"
mv -f "$launcher_stage" "$install_dir/maestro"
launcher_stage=""

printf 'Installed native Maestro %s to %s\n' "$release_version" "$install_dir/maestro" >&2
printf 'Release files retained under %s for rollback.\n' "$release_root" >&2
"$install_dir/maestro" --version
