#!/usr/bin/env bash
# Explicit macOS acceptance check with a disposable keychain and real signatures.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ "$(uname -s)" == Darwin ]] || { echo 'Requires macOS' >&2; exit 1; }
: "${MAESTRO_RELEASE_DEVELOPER_ID_AUTHORITY:?Set the Developer ID Application identity used by releases}"
fixture="$(mktemp -d)"
cleanup() {
  local delete_status=0
  if [[ -e "$fixture/probe.keychain-db" || -e "$fixture/probe.keychain" ]]; then
    "$fixture/v1/maestro" delete "$fixture/probe.keychain" || delete_status=$?
  fi
  rm -rf "$fixture"
  return "$delete_status"
}
trap cleanup EXIT
mkdir -p "$fixture/tools"
# Supply an actual compiled artifact through Cargo's message protocol so this
# exercises installation/signing without building the entire runtime twice.
cat > "$fixture/tools/cargo" <<'CARGO'
#!/usr/bin/env bash
node -e 'console.log(JSON.stringify({reason:"compiler-artifact",target:{name:"maestro",kind:["bin"]},executable:process.env.MAESTRO_SMOKE_EXECUTABLE}))'
CARGO
chmod 755 "$fixture/tools/cargo"
for version in 1 2; do
  mkdir -p "$fixture/v$version"
  clang -Wno-deprecated-declarations -DBUILD_VERSION="\"$version\"" \
    "$ROOT/scripts/fixtures/keychain-upgrade.c" -framework Security -framework CoreFoundation \
    -o "$fixture/build-v$version"
  PATH="$fixture/tools:$PATH" MAESTRO_SMOKE_EXECUTABLE="$fixture/build-v$version" \
    MAESTRO_INSTALL_PREFIX="$fixture/v$version" bash "$ROOT/scripts/install-native-local.sh"
  node "$ROOT/scripts/check-macos-release-signature.mjs" "$fixture/v$version/maestro"
done
"$fixture/v1/maestro" create "$fixture/probe.keychain"
"$fixture/v1/maestro" read "$fixture/probe.keychain"
"$fixture/v2/maestro" read "$fixture/probe.keychain"
# A changed identifier must fail without prompting, proving this test exercises
# the item's code-signing ACL rather than an unrestricted credential.
cp "$fixture/v2/maestro" "$fixture/different-identity"
codesign --force --identifier maestro-keychain-negative-control --options runtime --timestamp \
  --sign "$MAESTRO_RELEASE_DEVELOPER_ID_AUTHORITY" "$fixture/different-identity"
if negative_output="$("$fixture/different-identity" read "$fixture/probe.keychain")"; then
  echo 'Different signing identity unexpectedly accessed the credential' >&2
  exit 1
fi
printf '%s\n' "$negative_output"
# errSecAuthFailed or errSecInteractionNotAllowed; unrelated failures do not count.
[[ "$negative_output" == *'status=-25293' || "$negative_output" == *'status=-25308' ]] || exit 1
printf 'Keychain grant survived a changed binary and path; different identity was refused without UI.\n'
