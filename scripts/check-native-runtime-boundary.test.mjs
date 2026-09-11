import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checker = join(repositoryRoot, "scripts/check-native-runtime-boundary.mjs");

const runtimeManifest = `
[package]
name = "maestro-runtime"
version = "0.1.0"

[dependencies]
maestro-runtime-contracts.workspace = true
`;
const contractsManifest = `
[package]
name = "maestro-runtime-contracts"
version = "0.1.0"
`;
const tuiManifest = `
[package]
name = "maestro-tui"
version = "0.1.0"

[dependencies]
maestro-runtime.workspace = true
`;
const runtimeSource = `
pub struct NativeAgent {
    runner: Option<NativeAgentRunner>,
}

struct NativeAgentRunner;

impl NativeAgent {
    pub fn new() -> Self {
        Self { runner: None }
    }
}

impl NativeAgentRunner {
    async fn run(&mut self) {
        loop {
            break;
        }
    }
}
`;
const tuiSource = "pub use maestro_runtime::NativeAgent;\n";

function writeFixtureFile(root, path, contents) {
	const destination = join(root, path);
	mkdirSync(dirname(destination), { recursive: true });
	writeFileSync(destination, contents);
}

function createFixture(t, {
	runtimeCargo = runtimeManifest,
	contractsCargo = contractsManifest,
	tuiCargo = tuiManifest,
	runtimeRust = runtimeSource,
	contractsRust = "pub struct RuntimeContract;\n",
	tuiRust = tuiSource,
	extraMembers = [],
	extraFiles = {},
} = {}) {
	const root = mkdtempSync(join(tmpdir(), "maestro-native-runtime-boundary-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const members = [
		"packages/runtime-rs",
		"packages/runtime-contracts-rs",
		"packages/tui-rs",
		...extraMembers,
	];
	writeFixtureFile(
		root,
		"Cargo.toml",
		`[workspace]\nmembers = [\n${members.map((member) => `    "${member}",`).join("\n")}\n]\n\n[workspace.dependencies]\nmaestro-runtime = { path = "packages/runtime-rs" }\nmaestro-runtime-contracts = { path = "packages/runtime-contracts-rs" }\nmaestro-tui = { path = "packages/tui-rs" }\n`,
	);
	writeFixtureFile(root, "packages/runtime-rs/Cargo.toml", runtimeCargo);
	writeFixtureFile(root, "packages/runtime-rs/src/lib.rs", runtimeRust);
	writeFixtureFile(root, "packages/runtime-contracts-rs/Cargo.toml", contractsCargo);
	writeFixtureFile(root, "packages/runtime-contracts-rs/src/lib.rs", contractsRust);
	writeFixtureFile(root, "packages/tui-rs/Cargo.toml", tuiCargo);
	writeFixtureFile(root, "packages/tui-rs/src/lib.rs", tuiRust);
	for (const [path, contents] of Object.entries(extraFiles)) writeFixtureFile(root, path, contents);
	return root;
}

function runChecker(root) {
	const result = spawnSync(process.execPath, [checker, "--root", root, "--json"], {
		cwd: root,
		encoding: "utf8",
	});
	assert.equal(result.error, undefined, result.error?.message);
	return {
		...result,
		report: JSON.parse(result.stdout),
	};
}

test("accepts one runtime-owned agent and a TUI handle re-export", (t) => {
	const root = createFixture(t);
	const result = runChecker(root);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.report.ok, true);
	assert.deepEqual(result.report.violations, []);
	assert.deepEqual(
		result.report.owners.nativeAgent.map((owner) => owner.package),
		["maestro-runtime"],
	);
	assert.deepEqual(
		result.report.owners.nativeAgentRunner.map((owner) => owner.package),
		["maestro-runtime"],
	);
});

test("does not treat comments, docs, strings, or test modules as production owners", (t) => {
	const root = createFixture(t, {
		runtimeRust: `
// pub struct NativeAgentRunner;
const prose: &str = "pub struct NativeAgent { runner: NativeAgentRunner }";
#[cfg(test)]
mod tests {
    struct NativeAgent;
    struct NativeAgentRunner;
}
`,
		tuiRust: `
// struct NativeAgentRunner;
const prose: &str = "impl NativeAgentRunner { fn run_loop() {} }";
`,
	});
	const result = runChecker(root);
	assert.equal(result.status, 1);
	assert.ok(
		result.report.violations.some((violation) => violation.code === "runtime-missing-native-agent"),
	);
	assert.ok(
		result.report.violations.some((violation) => violation.code === "runtime-missing-native-agent-runner"),
	);
	assert.equal(
		result.report.violations.some((violation) => violation.code === "tui-owns-native-agent-runner"),
		false,
	);
});

test("rejects a direct aliased runtime dependency on maestro-ui", (t) => {
	const root = createFixture(t, {
		runtimeCargo: `${runtimeManifest}\nui_surface = { package = "maestro-ui", path = "../ui-rs" }\n`,
		extraMembers: ["packages/ui-rs"],
		extraFiles: {
		"packages/ui-rs/Cargo.toml": `[package]\nname = "maestro-ui"\nversion = "0.1.0"\n`,
		"packages/ui-rs/src/lib.rs": "pub struct Ui;\n",
	},
	});
	const result = runChecker(root);
	assert.equal(result.status, 1);
	const violation = result.report.violations.find(
		(candidate) => candidate.code === "runtime-forbidden-dependency",
	);
	assert.ok(violation);
	assert.match(violation.message, /maestro-ui/);
	assert.match(violation.message, /maestro-runtime -> maestro-ui/);
});

test("rejects a transitive dependency on ratatui", (t) => {
	const root = createFixture(t, {
		runtimeCargo: `${runtimeManifest}\nruntime_host_support = { path = "../runtime-host-support" }\n`,
		extraMembers: ["packages/runtime-host-support"],
		extraFiles: {
		"packages/runtime-host-support/Cargo.toml": `[package]\nname = "runtime-host-support"\nversion = "0.1.0"\n\n[dependencies]\nterminal = { package = "ratatui", version = "0.30" }\n`,
		"packages/runtime-host-support/src/lib.rs": "pub struct HostSupport;\n",
	},
	});
	const result = runChecker(root);
	assert.equal(result.status, 1);
	const violation = result.report.violations.find(
		(candidate) => candidate.code === "runtime-forbidden-dependency",
	);
	assert.ok(violation);
	assert.match(violation.message, /maestro-runtime -> runtime-host-support -> ratatui/);
});

test("rejects a contracts backedge through an aliased provider crate", (t) => {
	const root = createFixture(t, {
		contractsCargo: `${contractsManifest}\n[dependencies]\nprovider_bridge = { path = "../provider-bridge" }\n`,
		extraMembers: ["packages/provider-bridge"],
		extraFiles: {
		"packages/provider-bridge/Cargo.toml": `[package]\nname = "provider-bridge"\nversion = "0.1.0"\n\n[dependencies]\nloop_owner = { package = "maestro-runtime", path = "../runtime-rs" }\n`,
		"packages/provider-bridge/src/lib.rs": "pub struct ProviderBridge;\n",
	},
	});
	const result = runChecker(root);
	assert.equal(result.status, 1);
	const violation = result.report.violations.find(
		(candidate) => candidate.code === "contracts-backedge",
	);
	assert.ok(violation);
	assert.match(violation.message, /maestro-runtime/);
	assert.match(violation.message, /maestro-runtime-contracts -> provider-bridge -> maestro-runtime/);
});

test("rejects a duplicate NativeAgentRunner in the TUI", (t) => {
	const root = createFixture(t, {
		tuiRust: `${tuiSource}\nstruct NativeAgentRunner;\n`,
	});
	const result = runChecker(root);
	assert.equal(result.status, 1);
	assert.ok(
		result.report.violations.some((violation) => violation.code === "tui-owns-native-agent-runner"),
	);
});

test("rejects an independent TUI NativeAgent implementation", (t) => {
	const root = createFixture(t, {
		tuiRust: `
use unrelated_crate::NativeAgent as UnrelatedNativeAgent;
pub struct NativeAgent {
    local_state: UnrelatedNativeAgent,
}
impl NativeAgent {
    fn new() -> Self { Self { local_state: String::new() } }
}
`,
	});
	const result = runChecker(root);
	assert.equal(result.status, 1);
	assert.ok(
		result.report.violations.some((violation) => violation.code === "tui-owns-native-agent"),
	);
});

test("accepts a TUI wrapper whose field stores the runtime handle", (t) => {
	const root = createFixture(t, {
		tuiRust: `
use maestro_runtime::agent::NativeAgent as RuntimeNativeAgent;
pub struct NativeAgent {
    inner: RuntimeNativeAgent,
}
`,
	});
	const result = runChecker(root);
	assert.equal(result.status, 0, result.stderr);
});

test("rejects forbidden source imports while ignoring comments and strings", (t) => {
	const root = createFixture(t, {
		runtimeRust: `
pub struct NativeAgent;
pub struct NativeAgentRunner;
impl NativeAgent {}
impl NativeAgentRunner {
    fn run_loop(&mut self) {}
}
// use ratatui::widgets::Widget;
const documentation: &str = "maestro_ui::Widget";
use ratatui::widgets::Widget;
`,
	});
	const result = runChecker(root);
	assert.equal(result.status, 1);
	const violation = result.report.violations.find(
		(candidate) => candidate.code === "runtime-forbidden-source-import",
	);
	assert.ok(violation);
	assert.match(violation.message, /ratatui/);
	assert.match(violation.path, /packages\/runtime-rs\/src\/lib\.rs/);
});

test("the checker exposes a machine-readable report", (t) => {
	const root = createFixture(t, {
		tuiRust: "struct NativeAgentRunner;\n",
	});
	const result = runChecker(root);
	assert.equal(typeof result.report.schemaVersion, "string");
	assert.equal(result.report.schemaVersion, "evalops.maestro.native-runtime-boundary.v1");
	assert.equal(result.report.ok, false);
	assert.ok(Array.isArray(result.report.violations));
	assert.ok(result.report.violations.every((violation) => typeof violation.code === "string"));
});

test("the human report names the exact source location", (t) => {
	const root = createFixture(t, {
		tuiRust: "\n\nstruct NativeAgentRunner;\n",
	});
	const result = spawnSync(process.execPath, [checker, "--root", root], {
		cwd: root,
		encoding: "utf8",
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Native Maestro runtime boundary check failed:/);
	assert.match(result.stderr, /packages\/tui-rs\/src\/lib\.rs:3/);
});

function createHostFixture(t, { hostRust, hostExtra = "", gatewayExtra = "" } = {}) {
    return createFixture(t, {
        tuiCargo: tuiManifest + '\nmaestro-local-host = { path = "../local-host-rs" }\n',
        tuiRust: "pub use maestro_local_host::NativeAgent;\n",
        extraMembers: ["packages/local-host-rs", "packages/runtime-gateway-rs"],
        extraFiles: {
            "packages/local-host-rs/Cargo.toml": '[package]\nname = "maestro-local-host"\nversion = "0.1.0"\n[dependencies]\nmaestro-runtime.workspace = true\n' + hostExtra,
            "packages/local-host-rs/src/lib.rs": hostRust ?? "pub struct NativeAgent { inner: maestro_runtime::NativeAgent }\n",
            "packages/runtime-gateway-rs/Cargo.toml": '[package]\nname = "maestro-runtime-gateway"\nversion = "0.1.0"\n[dependencies]\nmaestro-local-host = { path = "../local-host-rs" }\n' + gatewayExtra,
            "packages/runtime-gateway-rs/src/lib.rs": "pub use maestro_local_host::NativeAgent;\n",
        },
    });
}

test("accepts a shared local host that carries the runtime handle", (t) => {
    const result = runChecker(createHostFixture(t));
    assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("rejects an independent agent in the shared local host", (t) => {
    const result = runChecker(createHostFixture(t, { hostRust: "pub struct NativeAgent;\n" }));
    assert.equal(result.status, 1);
    assert.ok(result.report.violations.some((v) => v.code === "host-owns-native-agent"));
});

test("rejects an aliased gateway dependency on the terminal application", (t) => {
    const result = runChecker(createHostFixture(t, {
        gatewayExtra: 'terminal = { package = "maestro-tui", path = "../tui-rs" }\n',
    }));
    assert.equal(result.status, 1);
    assert.ok(result.report.violations.some((v) => v.code === "gateway-depends-on-tui"));
});

test("rejects a terminal application dependency hidden behind the local host", (t) => {
    const result = runChecker(createHostFixture(t, { hostExtra: "maestro-tui.workspace = true\n" }));
    assert.equal(result.status, 1);
    assert.ok(result.report.violations.some((v) => v.code === "host-depends-on-tui"));
    assert.ok(result.report.violations.some((v) => v.code === "gateway-depends-on-tui"));
});
