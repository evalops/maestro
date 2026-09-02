#!/usr/bin/env bash
set -euo pipefail

# Cold hosted agents spend 40m+ fetching the IntelliJ SDK. Skip that on
# pull requests that do not touch the plugin; fail closed to a full run
# when the base branch is unavailable.
if [[ "${BUILDKITE_PULL_REQUEST:-false}" != "false" && -n "${BUILDKITE_PULL_REQUEST}" ]]; then
  base_branch="${BUILDKITE_PULL_REQUEST_BASE_BRANCH:-main}"
  git fetch --depth=80 origin "${base_branch}" >/dev/null 2>&1 || true
  if git rev-parse --verify "origin/${base_branch}" >/dev/null 2>&1; then
    if ! git diff --name-only "origin/${base_branch}...HEAD" | grep -q '^packages/jetbrains-plugin/'; then
      echo "No packages/jetbrains-plugin changes on this PR; skipping JetBrains validation."
      exit 0
    fi
  fi
fi

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
# Bound the Gradle JVM. Empty jvmargs let HotSpot pick a huge ergonomic
# heap, and the host OOM-killer then SIGKILLs the job (exit 137) or the
# daemon vanishes (exit 1) mid-:compileKotlin. 2g fits hosted linux-large
# without tripping the previous unbounded-heap killer. Cold hosted agents
# fetch the IntelliJ SDK from scratch; 40m stays under the 45m job
# timeout and avoids the inner timeout SIGKILL looking like an OOM.
timeout --signal=TERM --kill-after=30s 40m \
  ./gradlew check buildPlugin --no-daemon \
  -Dorg.gradle.workers.max=1 \
  -Dorg.gradle.jvmargs="-Xmx2g -XX:MaxMetaspaceSize=384m -XX:+ExitOnOutOfMemoryError"
