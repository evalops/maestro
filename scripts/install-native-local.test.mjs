import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const installer = new URL("install-native-local.sh", import.meta.url).pathname;
function fixture(t, { signingFails = false, noIdentity = false } = {}) {
	const root = mkdtempSync(join(tmpdir(), "maestro-local-install-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const bin = join(root, "tools");
	const prefix = join(root, "install");
	const target = join(root, "shared target", "debug");
	mkdirSync(bin); mkdirSync(prefix); mkdirSync(target, { recursive: true });
	const executable = join(target, "maestro");
	writeFileSync(executable, "new native binary");
	chmodSync(executable, 0o755);
	writeFileSync(join(prefix, "maestro"), "previous trusted binary");
	const tool = (name, body) => {
		writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
	};
	tool("uname", "echo Darwin");
	tool("cargo", `printf '%s\\n' '${JSON.stringify({ reason: "compiler-artifact", target: { name: "maestro", kind: ["bin"] }, executable })}'`);
	tool("codesign", `printf '%s\\n' "$*" >> "$FIXTURE_ROOT/codesign.log"\ncase "$1" in\n -dv) printf '%s\\n' 'Identifier=maestro' 'TeamIdentifier=TEAMID1234' 'Authority=Developer ID Application: Fixture (TEAMID1234)' >&2;;\n --force) ${signingFails ? "exit 1" : ":"};;\nesac`);
	tool("security", noIdentity ? "echo '0 valid identities found'" : "echo '  1) ABC \"Developer ID Application: Fixture (TEAMID1234)\"'");
	return { root, prefix, executable, run: () => spawnSync("bash", [installer], {
		encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_ROOT: root,
			MAESTRO_INSTALL_PREFIX: prefix, MAESTRO_CARGO_PROFILE: "dev", CARGO_TARGET_DIR: join(root, "shared target"),
			MAESTRO_RELEASE_DEVELOPER_ID_AUTHORITY: "Developer ID Application: Fixture (TEAMID1234)",
			MAESTRO_RELEASE_DEVELOPER_ID_TEAM_IDENTIFIER: "TEAMID1234" },
	}) };
}

test("local install signs the actual Cargo artifact and preserves the build cache", (t) => {
	const f = fixture(t);
	const result = f.run();
	assert.equal(result.status, 0, result.stderr);
	for (const name of ["maestro", "maestro-tui", "deixic-code"]) {
		assert.equal(readFileSync(join(f.prefix, name), "utf8"), "new native binary");
	}
	assert.equal(readFileSync(f.executable, "utf8"), "new native binary");
	const signing = readFileSync(join(f.root, "codesign.log"), "utf8");
	assert.match(signing, /--force --identifier maestro --options runtime --timestamp --sign Developer ID Application/);
	assert.ok(!signing.includes(f.executable), "sign a staged copy, never Cargo's cached artifact");
});

test("failed signing leaves the previous installation intact", (t) => {
	const f = fixture(t, { signingFails: true });
	assert.notEqual(f.run().status, 0);
	assert.equal(readFileSync(join(f.prefix, "maestro"), "utf8"), "previous trusted binary");
	assert.ok(!existsSync(join(f.prefix, "deixic-code")));
});

test("missing Developer ID refuses to overwrite a trusted installation", (t) => {
    const f = fixture(t, { noIdentity: true });
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /identity is unavailable/);
    assert.equal(readFileSync(join(f.prefix, "maestro"), "utf8"), "previous trusted binary");
});
