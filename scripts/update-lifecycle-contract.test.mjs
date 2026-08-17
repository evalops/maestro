import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildReleaseMetadata } from "./create-release-metadata.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("update lifecycle contract names every machine-readable surface", () => {
	const contract = JSON.parse(read("docs/protocols/update-lifecycle.json"));
	assert.equal(contract.schemaVersion, "evalops.maestro.update-lifecycle.v1");
	assert.deepEqual(Object.keys(contract.commands).sort(), ["apply", "history", "rollback", "status"]);
	assert.equal(contract.persistence.maximumAttempts, 32);
	assert.equal(contract.commands.apply.jsonSchema.channel, "stable|beta|alpha");
	assert.equal(contract.persistence.receiptSchema, "evalops.maestro.install-receipt.v1");
	assert.equal(contract.persistence.channelManifestSchema, "evalops.maestro.release-channel.v1");
	assert.equal(contract.commands.status.jsonSchema.channel, "stable|beta|alpha");
	assert.deepEqual(Object.keys(contract.persistence.channelManifestUrls).sort(), ["alpha", "beta", "stable"]);
	assert.equal(
		contract.commands.rollback.jsonSchema.launcherWarning,
		"string|null; launcher was replaced but parent-directory durability sync reported an error",
	);
});

test("release metadata carries changelog notes and exact runtime passports", async () => {
	const passport = {
		artifact: { name: "maestro-linux-x64", digest: `sha256:${"a".repeat(64)}` },
		schemaVersion: "evalops.maestro.runtime-passport.v1",
	};
	const metadata = await buildReleaseMetadata({
		version: "1.2.3",
		releaseTag: "v1.2.3",
		sourceSha: "b".repeat(40),
		changelog: "## [1.2.3] - 2026-08-16\n\n### Fixed\n\n- Preserve the receipt.\n\n## [1.2.2] - 2026-08-15\n",
		passports: [passport],
	});
	assert.equal(metadata.schemaVersion, "evalops.maestro.release-metadata.v1");
	assert.equal(metadata.releaseNotes, "### Fixed\n\n- Preserve the receipt.");
	assert.equal(metadata.receipt.sourceSha, "b".repeat(40));
	assert.deepEqual(metadata.receipt.artifacts, [
		{ name: "maestro-linux-x64", digest: `sha256:${"a".repeat(64)}`, runtimePassport: passport },
	]);
});

test("installer and signed release workflow publish receipt metadata", () => {
	const installer = read("scripts/install.sh");
	const release = read(".github/workflows/release.yml");
	const updater = read("packages/tui-rs/src/update_cli.rs");
	const channelManifest = read("scripts/create-release-channel-manifest.mjs");
	const channelResolver = read("scripts/resolve-release-channel.mjs");
	assert.match(installer, /release-metadata\.json/);
	assert.match(installer, /install-receipt\.json/);
	assert.match(installer, /cp \"\$tmpdir\/\$web_asset\" \"\$release_dir\/\$web_asset\"/);
	assert.match(installer, /MAESTRO_STARTUP_UPDATE_STATE/);
	assert.match(installer, /MAESTRO_INSTALL_CHANNEL/);
	assert.match(installer, /MAESTRO_UPDATE_CHANNEL/);
	assert.match(installer, /receipt_hash_file/);
	assert.doesNotMatch(installer, /refusing installation without release receipt metadata/);
	assert.match(updater, /restore_verified_web_tree/);
	assert.match(updater, /load_verified_release_metadata/);
	assert.match(updater, /Command::new\("tar"\)/);
	assert.match(updater, /durability_warning/);
	assert.match(updater, /channel_manifest_url/);
	assert.match(release, /create-release-metadata\.mjs/);
	assert.match(release, /release-metadata\.json/);
	assert.match(release, /files\+=\([^\n]*release-metadata\.json/);
	assert.match(release, /create-release-channel-manifest\.mjs/);
	assert.match(release, /channel-manifest\.json/);
	assert.match(channelManifest, /createPrivateKey/);
	assert.match(channelResolver, /alpha or beta/);
	assert.match(release, /Acquire::https::Timeout=10/);
	assert.match(release, /https:\/\/archive\.ubuntu\.com/);
	assert.match(release, /https:\/\/security\.ubuntu\.com/);
	assert.match(release, /No apt source files were available/);
});
