import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pipeline = await readFile(new URL("../.buildkite/pipeline.yml", import.meta.url), "utf8");
const nextest = await readFile(new URL("../.config/nextest.toml", import.meta.url), "utf8");

test("Buildkite routes every Maestro job to the available heavy self-hosted pool", () => {
  assert.match(pipeline, /agents:\n  queue: "hetzner-linux-heavy"/);
  assert.doesNotMatch(pipeline, /hetzner-linux-medium/);
});

test("Buildkite leaves one shared heavy worker available to other pipelines", () => {
  assert.equal((pipeline.match(/concurrency: 2/g) ?? []).length, 6);
  assert.equal(
    (pipeline.match(/concurrency_group: "hetzner-linux-heavy-workloads"/g) ?? [])
      .length,
    6,
  );
});

test("Buildkite retries only agent loss or stop", () => {
  assert.equal((pipeline.match(/exit_status: -1/g) ?? []).length, 6);
  assert.equal((pipeline.match(/signal_reason: none/g) ?? []).length, 6);
  assert.equal((pipeline.match(/signal_reason: agent_stop/g) ?? []).length, 6);
  assert.doesNotMatch(pipeline, /exit_status: "\*"/);
});

test("Buildkite network operations are bounded", () => {
  assert.equal((pipeline.match(/timeout --signal=TERM --kill-after=10s 5m npm ci --ignore-scripts/g) ?? []).length, 4);
  assert.match(pipeline, /npm_config_fetch_retries: "1"/);
  assert.match(pipeline, /npm_config_fetch_timeout: "30000"/);
  assert.equal((pipeline.match(/timeout --signal=TERM --kill-after=10s 2m docker pull/g) ?? []).length, 2);
  assert.match(pipeline, /timeout --signal=TERM --kill-after=10s 2m curl --fail/);
  for (const command of [
    "45m npm run check",
    "30m npm run lint",
    "45m cargo nextest run --profile buildkite --workspace --locked --no-fail-fast",
    "20m cargo test --workspace --locked --doc",
    "30m cargo build --locked -p maestro-tui",
    "45m npm run build",
    "30m cargo test --locked -p maestro-control-plane",
    "30m cargo build --locked -p maestro-scenario",
  ]) {
    assert.match(
      pipeline,
      new RegExp(`timeout --signal=TERM --kill-after=30s ${command.replaceAll("-", "\\-")}`),
    );
  }
});

test("Buildkite only runs the internal latency contract when it is present", () => {
  assert.match(
    pipeline,
    /if \[\[ -f scripts\/measure-ci-build-latency\.test\.mjs \]\]; then\n\s+node --test scripts\/measure-ci-build-latency\.test\.mjs\n\s+fi/,
  );
  assert.doesNotMatch(
    pipeline,
    /node --test scripts\/check-doc-paths\.test\.mjs scripts\/version\.test\.mjs scripts\/measure-ci-build-latency\.test\.mjs/,
  );
});

test("Rust validation uses the pinned canonical nextest split", () => {
  assert.match(
    pipeline,
    /export MAESTRO_TRUSTED_RUNNER_WORKSPACE_ROOTS="\$\$\(pwd -P\)"/,
  );
  assert.match(pipeline, /maestro_test_home="\$\$\(mktemp -d\)"/);
  assert.match(pipeline, /export MAESTRO_HOME="\$\$maestro_test_home"/);
  assert.match(
    pipeline,
    /export MAESTRO_SUBAGENTS_DIR="\$\$maestro_test_home\/subagents"/,
  );
  assert.match(pipeline, /trap 'rm -rf "\$\$maestro_test_home";/);
  assert.match(pipeline, /nextest_version="0\.9\.143"/);
  assert.match(
    pipeline,
    /66786b9abe23920d022a182d1416b1bbc8130dd4872a9553d76985a1708dcd1e/,
  );
  assert.match(pipeline, /sha256sum --check --status/);
  assert.match(pipeline, /cargo nextest run --profile buildkite --workspace --locked --no-fail-fast/);
  assert.match(pipeline, /cargo test --workspace --locked --doc/);
  assert.doesNotMatch(pipeline, /cargo test --workspace --locked\n/);
});

test("Buildkite serializes the PTY end-to-end binary under Nextest", () => {
  assert.match(nextest, /\[\[profile\.buildkite\.overrides\]\]/);
  assert.match(nextest, /filter = 'binary\(pty_e2e\)'/);
  assert.match(nextest, /test-group = 'pty-e2e'/);
  assert.match(nextest, /\[test-groups\.pty-e2e\]\nmax-threads = 1/);
});

test("integration containers are removed by their actual names", () => {
  assert.match(pipeline, /trap 'docker rm -f "\$\$redis" "\$\$postgres"/);
  assert.doesNotMatch(pipeline, /"'"'"\$\$(?:redis|postgres)/);
});
