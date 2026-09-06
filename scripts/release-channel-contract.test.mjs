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
const readReleaseWorkflow = () =>
	readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

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

test("release channel manifest builder uses the same strict channel policy", () => {
	const { privateKey } = generateKeyPairSync("ed25519");
	assert.throws(
		() =>
			buildReleaseChannelManifest({
				version: "1.2.3-beta.0",
				channel: "beta",
				keyId: "prerelease-test",
				releaseUrl: "https://github.com/evalops/maestro/releases/download/v1.2.3-beta.0",
				sourceSha: "a".repeat(40),
				privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
			}),
		/prerelease|release version/
	);
});

test("release channel resolution rejects non-numeric or zero prerelease ordinals", () => {
	for (const version of [
		"1.2.3-beta.foo",
		"1.2.3-beta.0",
		"1.2.3-alpha.foo",
		"1.2.3-alpha.0",
		"01.2.3",
	]) {
		assert.throws(() => resolveReleaseChannel(version), /release version|matching/);
	}
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

test("release workflow publishes the signed channel manifest as a public release asset", () => {
	const workflow = readReleaseWorkflow();
	assert.match(workflow, /softprops\/action-gh-release@[0-9a-f]{40}/);
	assert.match(
		workflow,
		/channel-manifest\.json/,
	);
	assert.doesNotMatch(workflow, /MAESTRO_RELEASE_GCP_SERVICE_ACCOUNT/);
	assert.doesNotMatch(workflow, /gcloud storage cp/);
	assert.match(read("docs/protocols/release-channels.json"), /releaseRepository/);
});

test("affected Maestro CI runs the release-channel regression suite", () => {
	const packageManifest = JSON.parse(read("package.json"));
	assert.match(packageManifest.scripts["check:release-channels"], /scripts\/test-install\.sh/);
	assert.match(packageManifest.scripts["check:release-channels"], /release-channel-contract\.test\.mjs/);
	assert.match(read("scripts/ci-linux-check.sh"), /npm run check:release-channels/);
});

test("affected Maestro CI keeps the package check contract without duplicate Cargo work", () => {
	const packageManifest = JSON.parse(read("package.json"));
	const ciScript = read("scripts/ci-linux-check.sh");
	assert.match(packageManifest.scripts.check, /cargo check --workspace --all-targets --locked/);
	for (const check of [
		"check:workspace-contract",
		"check:protocol-manifest",
		"check:runtime-passport",
		"check:rust-only-runtime",
		"check:helm-probes",
		"check:hook-dispatch",
		"check:session-transfer",
	]) {
		assert.match(ciScript, new RegExp(`npm run ${check}`));
	}
	assert.match(ciScript, /make check/);
	assert.doesNotMatch(ciScript, /^npm run check$/mu);
});
