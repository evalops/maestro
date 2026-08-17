import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
	buildReleaseChannelManifest,
	canonicalReleaseChannelPayload,
	RELEASE_CHANNEL_SCHEMA,
} from "./create-release-channel-manifest.mjs";
import { resolveReleaseChannel } from "./resolve-release-channel.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("release channel manifests sign the complete unsigned payload", () => {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const manifest = buildReleaseChannelManifest({
		version: "1.2.3-beta.1",
		channel: "beta",
		keyId: "prerelease-test",
		releaseUrl: "https://github.com/evalops/maestro/releases/download/v1.2.3-beta.1",
		metadataUrl: null,
		sourceSha: "a".repeat(40),
		issuedAtMs: 1,
		releaseNotes: "### Fixed\n\n- Keep the channel record.",
		privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
	});
	assert.equal(manifest.schemaVersion, RELEASE_CHANNEL_SCHEMA);
	assert.equal(
		verify(
			null,
			canonicalReleaseChannelPayload(manifest),
			publicKey,
			Buffer.from(manifest.signature, "base64"),
		),
		true,
	);
	const changed = { ...manifest, releaseUrl: `${manifest.releaseUrl}/changed` };
	assert.equal(
		verify(
			null,
			canonicalReleaseChannelPayload(changed),
			publicKey,
			Buffer.from(manifest.signature, "base64"),
		),
		false,
	);
});

test("release channel resolution binds prerelease names to channels", () => {
	assert.equal(resolveReleaseChannel("1.2.3"), "stable");
	assert.equal(resolveReleaseChannel("1.2.4-beta.7"), "beta");
	assert.equal(resolveReleaseChannel("1.2.5-alpha.8"), "alpha");
	assert.throws(() => resolveReleaseChannel("1.2.4-beta.7", "alpha"), /matching alpha version/);
	assert.throws(() => resolveReleaseChannel("1.2.4-rc.1"), /alpha or beta/);
});

test("release workflows require a channel and publish the signed manifest", () => {
	if (existsSync(new URL("../.github/workflows/sync-public-release-mirror.yml", import.meta.url))) {
		const internalWorkflow = read(".github/workflows/release.yml");
		assert.match(internalWorkflow, /channel:/);
		assert.match(internalWorkflow, /create-release-channel-manifest\.mjs/);
		assert.match(internalWorkflow, /channel-manifest\.json/);
	}
	assert.match(read("docs/protocols/release-channels.json"), /stable-2026-08-0c3df2ac/);
	assert.match(read("docs/protocols/release-channels.json"), /preview-2026-08-912a0dab/);
	assert.match(read("scripts/sync-package-metadata.js"), /if \(!existsSync\(target\.path\)\)/);
});
