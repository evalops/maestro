#!/usr/bin/env bash
set -euo pipefail

REPO="${MAESTRO_RELEASE_REPO:-evalops/maestro}"
install_channel="${MAESTRO_INSTALL_CHANNEL:-stable}"
COSIGN_VERSION="2.6.1"
STABLE_CHANNEL_KEY_ID="stable-2026-08-0c3df2ac"
PRERELEASE_CHANNEL_KEY_ID="preview-2026-08-912a0dab"
STABLE_CHANNEL_PUBLIC_KEY="IYgvaSwf2E9DioyEZ6Qcp/QMD1xpsjS0JgYluAAt0pE="
PRERELEASE_CHANNEL_PUBLIC_KEY="4DS+odrY7y1PMg7o4s0jY1FkgcPQb8jjdy0Nst05soA="
# Historical blobs were signed by evalops/maestro-internal and evalops/maestro
# release.yml. Live blobs are signed by evalops/mono maestro-release.yml.
COSIGN_IDENTITY_REGEXP='^https://github.com/evalops/(maestro-internal/.github/workflows/release\.yml|maestro/.github/workflows/release\.yml|mono/.github/workflows/maestro-release\.yml)@'
COSIGN_OIDC_ISSUER="https://token.actions.githubusercontent.com"

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

channel_version_matches() {
  local version="$1"
  local channel="$2"
  case "$channel" in
    stable) [[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ;;
    beta) [[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-beta\.[1-9][0-9]*$ ]] ;;
    alpha) [[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-alpha\.[1-9][0-9]*$ ]] ;;
    *) return 1 ;;
  esac
}

require_channel_version() {
  local version="${1#v}"
  local channel="$2"
  if channel_version_matches "$version" "$channel"; then
    return 0
  fi
  case "$channel" in
    stable)
      fail "stable channel requires a stable semver version: $version"
      ;;
    beta)
      fail "beta channel requires a beta prerelease version: $version"
      ;;
    alpha)
      fail "alpha channel requires an alpha prerelease version: $version"
      ;;
  esac
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

requested_version="${MAESTRO_INSTALL_VERSION:-}"
requested_version="${requested_version#v}"
if [[ -n "$requested_version" ]]; then
  require_channel_version "$requested_version" "$install_channel"
fi

if [[ -n "${MAESTRO_RELEASE_BASE_URL:-}" ]]; then
  release_url="${MAESTRO_RELEASE_BASE_URL%/}"
elif [[ -n "${MAESTRO_INSTALL_VERSION:-}" ]]; then
  release_url="https://github.com/${REPO}/releases/download/v${requested_version}"
else
  # Every channel resolves to an immutable GitHub release tag so that the
  # signed channel manifest and the downloaded artifacts describe one release.
  # An operator may still provide a legacy signed pointer explicitly for a
  # controlled migration.
  release_url=""
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

fetch_optional() {
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
    return 1
  fi
  case "$status" in
    2??) return 0 ;;
    *)
      rm -f "$destination"
      return 1
      ;;
  esac
}

json_field() {
  local file="$1"
  local field="$2"
  command -v python3 >/dev/null 2>&1 || return 1
  python3 -c 'import json,sys; value=json.load(open(sys.argv[1])).get(sys.argv[2]); print("" if value is None else value)' \
    "$file" "$field"
}

validate_channel_manifest() {
  local file="$1"
  local expected_channel="$2"
  local expected_key_id
  local expected_public_key
  case "$expected_channel" in
    stable)
      expected_key_id="$STABLE_CHANNEL_KEY_ID"
      expected_public_key="$STABLE_CHANNEL_PUBLIC_KEY"
      ;;
    beta|alpha)
      expected_key_id="$PRERELEASE_CHANNEL_KEY_ID"
      expected_public_key="$PRERELEASE_CHANNEL_PUBLIC_KEY"
      ;;
    *) return 1 ;;
  esac

  command -v python3 >/dev/null 2>&1 || {
    printf 'Channel manifest validation requires python3.\n' >&2
    return 1
  }
  local payload="$tmpdir/channel-manifest.payload"
  local signature="$tmpdir/channel-manifest.signature"
  local public_key="$tmpdir/channel-manifest.public-key"
  local bypass_signature=0
  case "$allow_unsigned" in
    1|true|yes) bypass_signature=1 ;;
  esac

  if ! python3 - "$file" "$expected_channel" "$REPO" "$payload" "$signature" "$public_key" \
    "$expected_key_id" "$expected_public_key" "$bypass_signature" <<'PY'
import base64
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse


def reject(message):
    print(f"Channel manifest: {message}", file=sys.stderr)
    raise SystemExit(1)


def canonicalize(value):
    if isinstance(value, list):
        return [canonicalize(item) for item in value]
    if isinstance(value, dict):
        return {key: canonicalize(value[key]) for key in sorted(value)}
    return value


try:
    manifest = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception as error:
    reject(f"invalid JSON: {error}")
if not isinstance(manifest, dict):
    reject("manifest must be a JSON object")

expected_channel = sys.argv[2]
repo = sys.argv[3]
if manifest.get("schemaVersion") != "evalops.maestro.release-channel.v1":
    reject("unsupported release channel manifest schema")
if manifest.get("channel") != expected_channel:
    reject(f"manifest channel does not match requested {expected_channel}")
if manifest.get("keyId") != sys.argv[7]:
    reject("manifest key ID does not match the requested channel")

version = str(manifest.get("version") or "")
patterns = {
    "stable": r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$",
    "beta": r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-beta\.[1-9][0-9]*$",
    "alpha": r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-alpha\.[1-9][0-9]*$",
}
if not re.fullmatch(patterns[expected_channel], version):
    reject(f"{expected_channel} channel requires a matching prerelease version")
if manifest.get("releaseTag") != f"v{version}":
    reject("manifest release tag does not match its version")

release_url = manifest.get("releaseUrl")
if not isinstance(release_url, str):
    reject("manifest release URL is missing")
parsed_release_url = urlparse(release_url)
if parsed_release_url.scheme == "https":
    expected_path = f"/{repo}/releases/download/v{version}"
    if (
        parsed_release_url.netloc.lower() != "github.com"
        or parsed_release_url.path.rstrip("/") != expected_path
    ):
        reject("manifest release URL is not the requested GitHub release")
elif not (
    parsed_release_url.scheme == "http"
    and parsed_release_url.hostname in {"127.0.0.1", "localhost"}
):
    reject("manifest release URL must use the requested GitHub release or a local test server")

metadata_url = manifest.get("metadataUrl")
if metadata_url is not None:
    if not isinstance(metadata_url, str):
        reject("manifest metadata URL is invalid")
    parsed_metadata_url = urlparse(metadata_url)
    if not (
        parsed_metadata_url.scheme == "https"
        or (
            parsed_metadata_url.scheme == "http"
            and parsed_metadata_url.hostname in {"127.0.0.1", "localhost"}
        )
    ):
        reject("manifest metadata URL must use HTTPS")

source_sha = manifest.get("sourceSha")
if not isinstance(source_sha, str) or not re.fullmatch(r"[0-9a-fA-F]{40}", source_sha):
    reject("manifest source SHA is invalid")
metadata_sha = manifest.get("metadataSha256")
if metadata_sha is not None and (
    not isinstance(metadata_sha, str)
    or not re.fullmatch(r"sha256:[0-9a-fA-F]{64}", metadata_sha)
):
    reject("manifest metadata digest is invalid")

signature_text = manifest.get("signature")
if not isinstance(signature_text, str) or not signature_text:
    reject("manifest signature is missing")
if sys.argv[9] == "1":
    raise SystemExit(0)

try:
    signature_bytes = base64.b64decode(signature_text, validate=True)
    public_key_bytes = base64.b64decode(sys.argv[8], validate=True)
except Exception as error:
    reject(f"manifest signature encoding is invalid: {error}")
if len(signature_bytes) != 64 or len(public_key_bytes) != 32:
    reject("manifest signature or public key has an invalid length")

unsigned = dict(manifest)
del unsigned["signature"]
payload = json.dumps(
    canonicalize(unsigned),
    ensure_ascii=False,
    separators=(",", ":"),
    allow_nan=False,
).encode("utf-8")
Path(sys.argv[4]).write_bytes(payload)
Path(sys.argv[5]).write_bytes(signature_bytes)
Path(sys.argv[6]).write_bytes(bytes.fromhex("302a300506032b6570032100") + public_key_bytes)
PY
  then
    return 1
  fi

  if [[ "$bypass_signature" == "1" ]]; then
    printf 'Warning: channel manifest signature verification was explicitly bypassed.\n' >&2
    return 0
  fi
  command -v openssl >/dev/null 2>&1 || {
    printf 'Channel manifest verification requires openssl.\n' >&2
    return 1
  }
  if openssl pkeyutl -verify -rawin -pubin -inkey "$public_key" \
    -in "$payload" -sigfile "$signature" >/dev/null 2>&1; then
    return 0
  fi
  openssl pkeyutl -verify -pubin -inkey "$public_key" \
    -in "$payload" -sigfile "$signature" >/dev/null 2>&1
}

latest_channel_tag() {
  local file="$1"
  local channel="$2"
  command -v python3 >/dev/null 2>&1 || return 1
  python3 -c '
import json, re, sys
channel = sys.argv[2]
releases = json.load(open(sys.argv[1], encoding="utf-8"))
if not isinstance(releases, list):
    raise SystemExit(1)
patterns = {
    "stable": r"((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$",
    "beta": r"((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)-beta\.[1-9][0-9]*)$",
    "alpha": r"((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)-alpha\.[1-9][0-9]*)$",
}
candidates = []
for release in releases:
    if release.get("draft"):
        continue
    if channel == "stable" and release.get("prerelease"):
        continue
    if channel != "stable" and not release.get("prerelease"):
        continue
    assets = release.get("assets") or []
    if not any(asset.get("name") == "channel-manifest.json" for asset in assets):
        continue
    tag = str(release.get("tag_name") or "")
    normalized_tag = tag[1:] if tag.startswith("v") else tag
    match = re.fullmatch(patterns[channel], normalized_tag)
    if match:
        version = match.group(1)
        core = re.split(r"[-.]", version)
        candidates.append((tuple(int(part) for part in core if part.isdigit()), tag))
if candidates:
    print(max(candidates)[1])
' "$file" "$channel"
}

fetch_github_releases() {
  local destination="$1"
  local api="$2"
  local page=1
  local separator
  local url
  local page_file
  local page_count
  command -v python3 >/dev/null 2>&1 || return 1
  printf '[]\n' > "$destination"
  while (( page <= 10 )); do
    if [[ "$api" == *\?* ]]; then
      separator='&'
    else
      separator='?'
    fi
    url="${api}${separator}per_page=100&page=${page}"
    page_file="$tmpdir/github-releases-page-${page}.json"
    fetch_optional "$page_file" "$url" || return 1
    python3 - "$destination" "$page_file" <<'PY'
import json
import sys

destination, page_file = sys.argv[1:]
with open(destination, encoding="utf-8") as handle:
    combined = json.load(handle)
with open(page_file, encoding="utf-8") as handle:
    page = json.load(handle)
if not isinstance(combined, list) or not isinstance(page, list):
    raise SystemExit(1)
with open(destination, "w", encoding="utf-8") as handle:
    json.dump(combined + page, handle)
PY
    page_count="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$page_file")"
    if (( page_count < 100 )); then
      return 0
    fi
    page=$((page + 1))
  done
  return 0
}

release_url_allowed() {
  case "$1" in
    https://*) return 0 ;;
    http://127.0.0.1:*|http://localhost:*) return 0 ;;
    *) return 1 ;;
  esac
}

resolve_channel_release_url() {
  local channel="$1"
  local pointer="${MAESTRO_CHANNEL_MANIFEST_URL:-}"
  local pointer_base="${MAESTRO_CHANNEL_POINTER_BASE:-}"
  local api="${MAESTRO_RELEASE_API_URL:-https://api.github.com/repos/${REPO}/releases}"
  local dest tag url

  if [[ -z "$pointer" && -n "$pointer_base" ]]; then
    pointer="${pointer_base%/}/channels/${channel}/manifest.json"
  fi
  dest="$tmpdir/channel-manifest.json"
  if [[ -n "$pointer" ]] && fetch_optional "$dest" "$pointer"; then
    if validate_channel_manifest "$dest" "$channel"; then
      url="$(json_field "$dest" releaseUrl || true)"
      url="${url%/}"
      if release_url_allowed "$url"; then
        printf 'Using %s channel pointer %s\n' "$channel" "$pointer" >&2
        : > "$tmpdir/channel-manifest-verified"
        printf '%s' "$url"
        return 0
      fi
    fi
    printf 'Warning: ignoring invalid %s channel pointer %s; trying GitHub Releases.\n' \
      "$channel" "$pointer" >&2
    rm -f "$dest"
  fi

  rm -f "$tmpdir/channel-manifest-verified"
  dest="$tmpdir/github-releases.json"
  if ! fetch_github_releases "$dest" "$api"; then
    fail "No published $channel release pointer at $pointer, and GitHub release listing failed: $api"
  fi
  command -v python3 >/dev/null 2>&1 ||
    fail "Resolving $channel requires python3 to read the GitHub Releases list"
  tag="$(latest_channel_tag "$dest" "$channel" || true)"
  if [[ -z "$tag" ]]; then
    fail "No published $channel release. Omit MAESTRO_INSTALL_CHANNEL for stable, or set MAESTRO_INSTALL_VERSION to a published tag."
  fi
  printf 'Using GitHub %s release %s\n' "$channel" "$tag" >&2
  printf '%s/%s' "${MAESTRO_RELEASE_DOWNLOAD_BASE:-https://github.com/${REPO}/releases/download}" "$tag"
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

if [[ -z "$release_url" ]]; then
  release_url="$(resolve_channel_release_url "$install_channel")"
fi

channel_manifest_verified=0
channel_manifest_version=""
channel_manifest="$tmpdir/channel-manifest.json"
if [[ ! -f "$tmpdir/channel-manifest-verified" ]]; then
  download "${release_url}/channel-manifest.json" "$channel_manifest" "channel manifest"
  validate_channel_manifest "$channel_manifest" "$install_channel" ||
    fail "Channel manifest verification failed for $install_channel"
fi
channel_manifest_verified=1
channel_manifest_version="$(json_field "$channel_manifest" version || true)"
channel_manifest_release_url="$(json_field "$channel_manifest" releaseUrl || true)"
channel_manifest_release_url="${channel_manifest_release_url%/}"
release_url_normalized="${release_url%/}"
[[ -n "$channel_manifest_version" && "$channel_manifest_release_url" == "$release_url_normalized" ]] ||
  fail "Channel manifest does not describe the selected $install_channel release"

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

version_output="$("$tmpdir/$asset" --version 2>/dev/null)" ||
  fail "Downloaded Maestro binary could not report its version"
release_version="$(printf '%s\n' "$version_output" | awk 'NF {print $NF; exit}')"
release_version="${release_version#v}"
[[ "$release_version" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*$ ]] ||
  fail "Invalid release version: $release_version"
if [[ -n "$requested_version" && "$release_version" != "$requested_version" ]]; then
  fail "Downloaded release version $release_version does not match requested version $requested_version"
fi
require_channel_version "$release_version" "$install_channel"
if [[ "$channel_manifest_verified" == "1" && "$channel_manifest_version" != "$release_version" ]]; then
  fail "Channel manifest version $channel_manifest_version does not match downloaded release $release_version"
fi

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
