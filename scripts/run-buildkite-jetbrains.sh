#!/usr/bin/env bash
set -euo pipefail

tool_root="${BUILDKITE_BUILD_CHECKOUT_PATH:-$(pwd)}/.buildkite/cache/jetbrains-tools"
jdk_root="$tool_root/jdk-21"
if ! java -version 2>&1 | head -1 | grep -Eq 'version "21([.]|\")'; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) os=linux; arch=x64 ;;
    Linux-aarch64 | Linux-arm64) os=linux; arch=aarch64 ;;
    Darwin-x86_64) os=mac; arch=x64 ;;
    Darwin-arm64 | Darwin-aarch64) os=mac; arch=aarch64 ;;
    *) echo "unsupported JDK platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
  esac
  if [[ ! -x "$jdk_root/bin/java" ]]; then
    archive="$(mktemp)"
    unpack="$(mktemp -d)"
    trap 'rm -f "$archive"; rm -rf "$unpack"' EXIT
    mkdir -p "$tool_root"
    curl --fail --location --silent --show-error --max-time 180 --retry 2 \
      "https://api.adoptium.net/v3/binary/latest/21/ga/${os}/${arch}/jdk/hotspot/normal/eclipse" \
      --output "$archive"
    tar -xzf "$archive" -C "$unpack"
    jdk_home="$(find "$unpack" -type f -path '*/bin/java' -print -quit)"
    [[ -n "$jdk_home" ]] || { echo "downloaded JDK did not contain bin/java" >&2; exit 1; }
    jdk_home="${jdk_home%/bin/java}"
    mv "$jdk_home" "$jdk_root"
  fi
  export JAVA_HOME="$jdk_root"
  export PATH="$JAVA_HOME/bin:$PATH"
fi

java -version
cd packages/jetbrains-plugin
timeout --signal=TERM --kill-after=30s 35m ./gradlew check buildPlugin --no-daemon
