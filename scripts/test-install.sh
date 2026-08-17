#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for cmd in curl mktemp mkdir printf tar python3 find dirname chmod awk sleep cat wc tr rm cp; do
  command -v "$cmd" >/dev/null || {
    printf 'Required command not found: %s\n' "$cmd" >&2
    exit 1
  }
done

fail() {
  printf 'Install fixture failed: %s\n' "$*" >&2
  exit 1
}

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

fixture="$(mktemp -d 2>/dev/null || mktemp -d -t maestro-install-fixture)"
server_pid=""
cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$fixture"
}
trap cleanup EXIT

platform_os="$(uname -s)"
platform_arch="$(uname -m)"
case "$platform_os:$platform_arch" in
  Darwin:arm64) platform=darwin-arm64 ;;
  Darwin:x86_64|Darwin:amd64) platform=darwin-x64 ;;
  Linux:aarch64|Linux:arm64) platform=linux-arm64 ;;
  Linux:x86_64|Linux:amd64) platform=linux-x64 ;;
  *) fail "unsupported test host: $platform_os/$platform_arch" ;;
esac

asset="maestro-$platform"
web_asset="maestro-web-dist.tar.gz"
release_dir="$fixture/v0.0.1"
manifest_failure_release_dir="$fixture/v0.0.2"
mkdir -p "$release_dir" "$manifest_failure_release_dir" "$fixture/web-source" "$fixture/home"
printf '%s\n' '<!doctype html><title>fixture</title>' > "$fixture/web-source/index.html"
tar -czf "$release_dir/$web_asset" -C "$fixture/web-source" .

write_fixture_binary() {
  local version="$1"
  {
    printf '%s\n' '#!/bin/sh'
	    # shellcheck disable=SC2016
	    printf 'if [ "$1" = "--version" ]; then printf "maestro %s\\n"; elif [ "$1" = "--print-web-root" ]; then printf "%%s\\n" "$MAESTRO_WEB_STATIC_ROOT"; else printf "fixture binary\\n"; fi\n' "$version"
  } > "$release_dir/$asset"
  chmod 755 "$release_dir/$asset"
}

write_manifest() {
  local binary_digest
  local web_digest
  binary_digest="$(hash_file "$release_dir/$asset")"
  web_digest="$(hash_file "$release_dir/$web_asset")"
  {
    printf '%s  %s\n' "$binary_digest" "$asset"
    printf '%s  %s\n' "$web_digest" "$web_asset"
  } > "$release_dir/SHA256SUMS"
}

write_fixture_binary "0.0.1"
write_manifest
cp "$release_dir/$asset" "$manifest_failure_release_dir/$asset"
cp "$release_dir/$web_asset" "$manifest_failure_release_dir/$web_asset"

preview_release_dir="$fixture/v0.0.3-beta.1"
mkdir -p "$preview_release_dir"
write_fixture_binary "0.0.3-beta.1"
write_manifest
cp "$release_dir/$asset" "$preview_release_dir/$asset"
cp "$release_dir/$web_asset" "$preview_release_dir/$web_asset"
{
  printf '%s  %s\n' "$(hash_file "$preview_release_dir/$asset")" "$asset"
  printf '%s  %s\n' "$(hash_file "$preview_release_dir/$web_asset")" "$web_asset"
} > "$preview_release_dir/SHA256SUMS"
write_fixture_binary "0.0.1"
write_manifest

port_file="$fixture/port"
python3 - "$fixture" > "$port_file" 2>"$fixture/server.log" <<'PY' &
import http.server
import json
import os
import sys

os.chdir(sys.argv[1])
class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/v0.0.2/SHA256SUMS":
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b"simulated manifest failure")
            return
        if self.path == "/channels/beta/manifest.json":
            port = self.server.server_address[1]
            body = json.dumps({
                "channel": "beta",
                "releaseUrl": f"http://127.0.0.1:{port}/v0.0.3-beta.1",
                "version": "0.0.3-beta.1",
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/github/releases":
            port = self.server.server_address[1]
            body = json.dumps([
                {
                    "tag_name": "v0.0.3-beta.1",
                    "draft": False,
                    "prerelease": True,
                    "html_url": f"http://127.0.0.1:{port}/v0.0.3-beta.1",
                }
            ]).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/github/empty":
            body = b"[]"
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if "maestro-beta-channel" in self.path or "maestro-alpha-channel" in self.path:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"deleted channel alias")
            return
        super().do_GET()

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print(server.server_port, flush=True)
server.serve_forever()
PY
server_pid="$!"

for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
	[[ -s "$port_file" ]] && break
	if (( attempt == 20 )); then
		fail "fixture HTTP server did not start: $(cat "$fixture/server.log")"
	fi
	sleep 0.1
done
read -r port < "$port_file"

install_dir="$fixture/bin"
data_dir="$fixture/data"
release_url="http://127.0.0.1:$port/v0.0.1"
run_install() {
  HOME="$fixture/home" \
  MAESTRO_INSTALL_DIR="$install_dir" \
  MAESTRO_DATA_DIR="$data_dir" \
  MAESTRO_INSTALL_VERSION="0.0.1" \
  MAESTRO_INSTALL_CHANNEL="beta" \
  MAESTRO_RELEASE_BASE_URL="$release_url" \
  MAESTRO_ALLOW_UNSIGNED_INSTALL=1 \
  "$ROOT/scripts/install.sh"
}

run_install > "$fixture/first-install.log" 2>&1 ||
  fail "first install failed: $(cat "$fixture/first-install.log")"
[[ -x "$install_dir/maestro" ]] || fail "launcher was not installed"
grep -q '^export MAESTRO_INSTALL_METHOD=release$' "$install_dir/maestro" ||
  fail "launcher did not identify the signed release install method"
grep -q '^export MAESTRO_INSTALL_DIR=' "$install_dir/maestro" ||
  fail "launcher did not retain its install directory"
grep -q '^export MAESTRO_DATA_DIR=' "$install_dir/maestro" ||
  fail "launcher did not retain its data directory"
grep -q '^export MAESTRO_UPDATE_CHANNEL=' "$install_dir/maestro" ||
  fail "launcher did not retain its update channel"
[[ "$(MAESTRO_UPDATE_CHANNEL='' "$install_dir/maestro" --version)" == "maestro 0.0.1" ]] ||
  fail "launcher with a persisted beta channel did not execute"
grep -q '^export MAESTRO_STARTUP_UPDATE_STATE=' "$install_dir/maestro" ||
  fail "launcher did not retain startup update metadata"
grep -q '^export MAESTRO_VERSION=' "$install_dir/maestro" ||
  fail "launcher did not retain its installed version"
[[ "$("$install_dir/maestro" --version)" == "maestro 0.0.1" ]] ||
  fail "launcher did not execute the first release"
release_binary="$(find "$data_dir/releases" -type f -path '*/bin/maestro' -print -quit)"
[[ -n "$release_binary" ]] || fail "versioned release binary was not staged"
release_root="$(dirname "$(dirname "$release_binary")")"
[[ -f "$release_root/web/index.html" ]] || fail "web assets were not staged beside the binary"
[[ -f "$release_root/$web_asset" ]] || fail "verified web archive was not retained beside the binary"
[[ -f "$release_root/install-receipt.json" ]] || fail "install receipt was not staged beside the binary"
python3 - "$release_root/install-receipt.json" <<'PY'
import json
import sys

receipt = json.load(open(sys.argv[1], encoding="utf-8"))
assert receipt["schemaVersion"] == "evalops.maestro.install-receipt.v1"
assert receipt["version"] == "0.0.1"
assert receipt["verified"] is False
assert receipt["verification"]["artifactSha256"].startswith("sha256:")
assert receipt["verification"]["webSha256"].startswith("sha256:")
assert receipt["verification"]["metadataSha256"] is None
assert receipt["releaseMetadataAsset"] is None
PY
release_dir_name="${release_root##*/}"
case "$release_dir_name" in
  "$platform".??????) ;;
  *) fail "release directory is not uniquely allocated: $release_dir_name" ;;
esac

custom_web_root="$fixture/custom-web-root"
[[ "$(MAESTRO_WEB_STATIC_ROOT="$custom_web_root" "$install_dir/maestro" --print-web-root)" == "$custom_web_root" ]] ||
  fail "launcher overwrote an explicit MAESTRO_WEB_STATIC_ROOT"
default_web_root="$(
  unset MAESTRO_WEB_STATIC_ROOT
  "$install_dir/maestro" --print-web-root
)"
expected_default_web_root="$(cd "$release_root/web" && pwd -P)"
[[ "$default_web_root" == "$expected_default_web_root" ]] ||
  fail "launcher did not provide the bundled default web root"

runtime_version_install_dir="$fixture/runtime-version-bin"
runtime_version_data_dir="$fixture/runtime-version-data"
HOME="$fixture/home" \
MAESTRO_INSTALL_DIR="$runtime_version_install_dir" \
MAESTRO_DATA_DIR="$runtime_version_data_dir" \
MAESTRO_VERSION="9.9.9" \
MAESTRO_RELEASE_BASE_URL="$release_url" \
MAESTRO_ALLOW_UNSIGNED_INSTALL=1 \
"$ROOT/scripts/install.sh" > "$fixture/runtime-version-install.log" 2>&1 ||
  fail "runtime version metadata affected install: $(cat "$fixture/runtime-version-install.log")"
[[ "$("$runtime_version_install_dir/maestro" --version)" == "maestro 0.0.1" ]] ||
  fail "runtime version metadata pinned the installed binary"
[[ -d "$runtime_version_data_dir/releases/0.0.1" ]] ||
  fail "runtime version metadata changed the staged release version"
[[ ! -e "$runtime_version_data_dir/releases/9.9.9" ]] ||
  fail "runtime version metadata was interpreted as an installer pin"

if HOME="$fixture/home" \
  MAESTRO_INSTALL_CHANNEL="nightly" \
  "$ROOT/scripts/install.sh" > "$fixture/invalid-channel.log" 2>&1; then
  fail "installer accepted an unknown update channel"
fi
grep -q 'MAESTRO_INSTALL_CHANNEL must be stable, beta, or alpha' "$fixture/invalid-channel.log" ||
  fail "installer did not explain the invalid channel"

relative_install_dir="$fixture/relative-bin"
mkdir -p "$fixture/invocation"
(
  cd "$fixture"
  HOME="$fixture/home" \
  MAESTRO_INSTALL_DIR="$relative_install_dir" \
  MAESTRO_DATA_DIR="relative-data" \
  MAESTRO_INSTALL_VERSION="0.0.1" \
  MAESTRO_RELEASE_BASE_URL="$release_url" \
  MAESTRO_ALLOW_UNSIGNED_INSTALL=1 \
  "$ROOT/scripts/install.sh" > "$fixture/relative-install.log" 2>&1
) || fail "relative data directory install failed: $(cat "$fixture/relative-install.log")"
relative_version="$(
  cd "$fixture/invocation"
  "$relative_install_dir/maestro" --version
)"
[[ "$relative_version" == "maestro 0.0.1" ]] ||
  fail "launcher with relative data directory failed outside the install directory"

if HOME="$fixture/home" \
  MAESTRO_INSTALL_DIR="$install_dir" \
  MAESTRO_DATA_DIR="$data_dir" \
  MAESTRO_INSTALL_VERSION="0.0.2" \
  MAESTRO_RELEASE_BASE_URL="http://127.0.0.1:$port/v0.0.2" \
  MAESTRO_ALLOW_UNSIGNED_INSTALL=1 \
  "$ROOT/scripts/install.sh" > "$fixture/manifest-failure.log" 2>&1; then
  fail "manifest transport failure unexpectedly downgraded to unsigned install"
fi
[[ "$("$install_dir/maestro" --version)" == "maestro 0.0.1" ]] ||
  fail "manifest transport failure changed the active launcher"
release_binary_count="$(find "$data_dir/releases" -type f -path '*/bin/maestro' | wc -l | tr -d ' ')"
[[ "$release_binary_count" == "1" ]] ||
  fail "manifest transport failure published an extra release: $release_binary_count"

if HOME="$fixture/home" \
  MAESTRO_INSTALL_DIR="$install_dir" \
  MAESTRO_DATA_DIR="$data_dir" \
  MAESTRO_INSTALL_VERSION="0.0.1" \
  MAESTRO_RELEASE_BASE_URL="$release_url" \
  MAESTRO_REQUIRE_SIGNED_INSTALL=1 \
  MAESTRO_ALLOW_UNSIGNED_INSTALL=1 \
  "$ROOT/scripts/install.sh" > "$fixture/conflicting-signing-flags.log" 2>&1; then
  fail "strict signing accepted the unsigned bypass override"
fi
[[ "$("$install_dir/maestro" --version)" == "maestro 0.0.1" ]] ||
  fail "conflicting signing flags changed the active launcher"

if HOME="$fixture/home" \
  MAESTRO_INSTALL_DIR="$install_dir" \
  MAESTRO_DATA_DIR="$data_dir" \
  MAESTRO_INSTALL_VERSION="0.0.1" \
  MAESTRO_RELEASE_BASE_URL="$release_url" \
  MAESTRO_REQUIRE_SIGNED_INSTALL=1 \
  "$ROOT/scripts/install.sh" > "$fixture/strict-install.log" 2>&1; then
  fail "strict mode accepted an unsigned fixture"
fi
[[ "$("$install_dir/maestro" --version)" == "maestro 0.0.1" ]] ||
  fail "strict-mode failure changed the active launcher"

# Corrupt the binary without changing SHA256SUMS. The checksum failure must
# happen before a new release directory or launcher is published.
write_fixture_binary "9.9.9"
if run_install > "$fixture/corrupt-install.log" 2>&1; then
  fail "corrupt binary unexpectedly installed"
fi
[[ "$("$install_dir/maestro" --version)" == "maestro 0.0.1" ]] ||
  fail "checksum failure changed the active launcher"
release_binary_count="$(find "$data_dir/releases" -type f -path '*/bin/maestro' | wc -l | tr -d ' ')"
[[ "$release_binary_count" == "1" ]] ||
  fail "checksum failure published an extra release: $release_binary_count"

pointer_install_dir="$fixture/pointer-bin"
pointer_data_dir="$fixture/pointer-data"
HOME="$fixture/home" \
MAESTRO_INSTALL_DIR="$pointer_install_dir" \
MAESTRO_DATA_DIR="$pointer_data_dir" \
MAESTRO_INSTALL_CHANNEL="beta" \
MAESTRO_CHANNEL_MANIFEST_URL="http://127.0.0.1:$port/channels/beta/manifest.json" \
MAESTRO_ALLOW_UNSIGNED_INSTALL=1 \
"$ROOT/scripts/install.sh" > "$fixture/pointer-install.log" 2>&1 ||
  fail "channel pointer install failed: $(cat "$fixture/pointer-install.log")"
[[ "$("$pointer_install_dir/maestro" --version)" == "maestro 0.0.3-beta.1" ]] ||
  fail "channel pointer install did not select the preview release"
grep -q 'Using beta channel pointer' "$fixture/pointer-install.log" ||
  fail "channel pointer install did not report the signed pointer"
grep -q 'maestro-beta-channel' "$fixture/pointer-install.log" &&
  fail "channel pointer install requested the deleted GitHub channel alias"

api_install_dir="$fixture/api-bin"
api_data_dir="$fixture/api-data"
HOME="$fixture/home" \
MAESTRO_INSTALL_DIR="$api_install_dir" \
MAESTRO_DATA_DIR="$api_data_dir" \
MAESTRO_INSTALL_CHANNEL="beta" \
MAESTRO_CHANNEL_MANIFEST_URL="http://127.0.0.1:$port/missing-channel-pointer" \
MAESTRO_RELEASE_API_URL="http://127.0.0.1:$port/github/releases" \
MAESTRO_RELEASE_DOWNLOAD_BASE="http://127.0.0.1:$port" \
MAESTRO_ALLOW_UNSIGNED_INSTALL=1 \
"$ROOT/scripts/install.sh" > "$fixture/api-install.log" 2>&1 ||
  fail "GitHub channel fallback install failed: $(cat "$fixture/api-install.log")"
[[ "$("$api_install_dir/maestro" --version)" == "maestro 0.0.3-beta.1" ]] ||
  fail "GitHub channel fallback did not select the preview release"
grep -q 'Using GitHub beta release v0.0.3-beta.1' "$fixture/api-install.log" ||
  fail "GitHub channel fallback did not report the immutable tag"

if HOME="$fixture/home" \
  MAESTRO_INSTALL_DIR="$fixture/empty-bin" \
  MAESTRO_DATA_DIR="$fixture/empty-data" \
  MAESTRO_INSTALL_CHANNEL="beta" \
  MAESTRO_CHANNEL_MANIFEST_URL="http://127.0.0.1:$port/missing-channel-pointer" \
  MAESTRO_RELEASE_API_URL="http://127.0.0.1:$port/github/empty" \
  MAESTRO_ALLOW_UNSIGNED_INSTALL=1 \
  "$ROOT/scripts/install.sh" > "$fixture/empty-channel.log" 2>&1; then
  fail "installer accepted a preview channel with no published release"
fi
grep -q 'No published beta release' "$fixture/empty-channel.log" ||
  fail "installer did not explain a missing preview release"

printf 'installer fixture passed: checksum failure preserved %s\n' "$install_dir/maestro"
