#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_DIR="$ROOT/native/device-identity"
OUTPUT_DIR="$ROOT/native"
OUTPUT_NAME="maestro-device-identity"

if [[ "$(uname -s)" != "Darwin" ]]; then
	echo "Skipping Secure Enclave device identity helper build on non-macOS host."
	exit 0
fi

mkdir -p "$OUTPUT_DIR"

# shellcheck disable=SC2206
ARCHS=(${MAESTRO_DEVICE_IDENTITY_ARCHS:-arm64 x86_64})

if [[ "${#ARCHS[@]}" -eq 1 ]]; then
	swift build --package-path "$PACKAGE_DIR" -c release --arch "${ARCHS[0]}"
	BIN_DIR="$(swift build --package-path "$PACKAGE_DIR" -c release --arch "${ARCHS[0]}" --show-bin-path)"
	cp "$BIN_DIR/$OUTPUT_NAME" "$OUTPUT_DIR/$OUTPUT_NAME"
else
	SLICE_PATHS=()
	for ARCH in "${ARCHS[@]}"; do
		swift build --package-path "$PACKAGE_DIR" -c release --arch "$ARCH"
		BIN_DIR="$(swift build --package-path "$PACKAGE_DIR" -c release --arch "$ARCH" --show-bin-path)"
		SLICE_PATH="$OUTPUT_DIR/$OUTPUT_NAME-$ARCH"
		cp "$BIN_DIR/$OUTPUT_NAME" "$SLICE_PATH"
		SLICE_PATHS+=("$SLICE_PATH")
	done
	lipo -create "${SLICE_PATHS[@]}" -output "$OUTPUT_DIR/$OUTPUT_NAME"
	rm -f "${SLICE_PATHS[@]}"
fi

chmod 0755 "$OUTPUT_DIR/$OUTPUT_NAME"
