import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("secure session transfer contract is versioned and fail-closed", () => {
	const contract = JSON.parse(read("docs/protocols/secure-session-transfer.json"));
	assert.equal(contract.schemaVersion, "evalops.maestro.secure-session-transfer.v1");
	assert.equal(contract.envelope.format, "evalops.maestro.secure-session.v1");
	assert.deepEqual(contract.envelope.required, [
		"format",
		"bundleId",
		"issuedAt",
		"recipient",
		"encryption",
		"signer",
	]);
	assert.equal(contract.envelope.encryption.algorithm, "AES-256-GCM");
	assert.equal(contract.envelope.signer.algorithm, "Ed25519");
	assert.equal(contract.envelope.signature.domain, "evalops.maestro.secure-session.signature.v1");
	assert.match(contract.envelope.signature.payload, /canonical JSON/);
	assert.equal(contract.limits.maximumEnvelopeBytes, 16 * 1024 * 1024);
	assert.equal(contract.compatibility.unknownFields, "rejected");
	assert.match(contract.keys.encryptionKeyFile, /must not be group- or world-readable/);
});

	test("CLI and Rust implementation expose the secure transfer boundary", () => {
		const cli = read("packages/tui-rs/src/cli_commands.rs");
		const transfer = read("packages/tui-rs/src/session_transfer.rs");
		const secureTransfer = read("packages/tui-rs/src/session_transfer_secure.rs");
	assert.match(cli, /secure-json/);
	assert.match(cli, /--encryption-key-file/);
	assert.match(cli, /--verify-key-file/);
	assert.match(transfer, /SECURE_PORTABLE_FORMAT/);
		assert.match(
			secureTransfer,
			/SECURE_SIGNATURE_DOMAIN: &\[u8\] = b"evalops\.maestro\.secure-session\.signature\.v1";/,
		);
		assert.match(secureTransfer, /AES-256-GCM/);
		assert.match(secureTransfer, /Ed25519/);
		assert.match(secureTransfer, /ensure_secure_bundle_size/);
		assert.match(transfer, /portableBundleId/);
		assert.match(secureTransfer, /secure session signature mismatch/);
		assert.match(secureTransfer, /secure session payload decryption failed/);
	});
