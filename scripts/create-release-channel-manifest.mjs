#!/usr/bin/env node

import { createHash, createPrivateKey, sign } from "node:crypto";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_CHANNEL_SCHEMA = "evalops.maestro.release-channel.v1";

function parseArgs(argv) {
	const values = {};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (!argument.startsWith("--")) throw new Error(`Unknown argument: ${argument}`);
		const key = argument.slice(2).replaceAll("-", "_");
		values[key] = argv[index + 1] ?? "";
		index += 1;
	}
	for (const field of ["version", "channel", "key_id", "release_url", "source_sha", "out"]) {
		if (!values[field]?.trim()) throw new Error(`missing required --${field.replaceAll("_", "-")}`);
	}
	if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(values.version.trim())) {
		throw new Error("release version must be semver-like");
	}
	if (!["stable", "beta", "alpha"].includes(values.channel.trim())) {
		throw new Error("release channel must be stable, alpha, or beta");
	}
	if (!/^https:\/\//.test(values.release_url.trim())) {
		throw new Error("release URL must use HTTPS");
	}
	if (values.metadata_url && !/^https:\/\//.test(values.metadata_url.trim())) {
		throw new Error("metadata URL must use HTTPS");
	}
	if (!/^[0-9a-f]{40}$/i.test(values.source_sha.trim())) {
		throw new Error("source SHA must be forty hexadecimal characters");
	}
	if (values.issued_at_ms && !/^\d+$/.test(values.issued_at_ms)) {
		throw new Error("issued-at-ms must be an integer");
	}
	return values;
}

function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonicalize(value[key])]),
		);
	}
	return value;
}

export function canonicalReleaseChannelPayload(manifest) {
	const unsigned = { ...manifest };
	delete unsigned.signature;
	return Buffer.from(JSON.stringify(canonicalize(unsigned)));
}

export function buildReleaseChannelManifest({
	version,
	channel,
	keyId,
	releaseUrl,
	metadataUrl = null,
	metadataSha256 = null,
	sourceSha,
	issuedAtMs = Date.now(),
	releaseNotes = null,
	releaseReceipt = null,
	privateKeyPem,
}) {
	if (!privateKeyPem?.trim()) throw new Error("channel signing key is not configured");
	const normalizedVersion = version.replace(/^v/, "");
	const unsigned = {
		schemaVersion: RELEASE_CHANNEL_SCHEMA,
		channel,
		keyId,
		version: normalizedVersion,
		releaseTag: `v${normalizedVersion}`,
		releaseUrl,
		metadataUrl,
		metadataSha256,
		sourceSha: sourceSha.toLowerCase(),
		issuedAtMs,
		releaseNotes,
		releaseReceipt,
	};
	const signature = sign(null, canonicalReleaseChannelPayload(unsigned), createPrivateKey(privateKeyPem));
	return { ...unsigned, signature: signature.toString("base64") };
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const metadata = options.metadata_file
		? JSON.parse(await fs.readFile(options.metadata_file, "utf8"))
		: {};
	const metadataBytes = options.metadata_file ? await fs.readFile(options.metadata_file) : null;
	const manifest = buildReleaseChannelManifest({
		version: options.version,
		channel: options.channel,
		keyId: options.key_id,
		releaseUrl: options.release_url,
		metadataUrl: options.metadata_url || null,
		metadataSha256: metadataBytes ? `sha256:${createHash("sha256").update(metadataBytes).digest("hex")}` : null,
		sourceSha: options.source_sha,
		issuedAtMs: options.issued_at_ms ? Number(options.issued_at_ms) : Date.now(),
		releaseNotes: metadata.releaseNotes ?? null,
		releaseReceipt: metadata.receipt ?? null,
		privateKeyPem: process.env.MAESTRO_CHANNEL_PRIVATE_KEY,
	});
	await fs.writeFile(options.out, `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(`Wrote signed ${options.channel} release channel manifest to ${options.out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => {
		console.error(`Failed to create release channel manifest: ${error.message}`);
		process.exit(1);
	});
}
