#!/usr/bin/env node

import { promises as fs } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const RELEASE_METADATA_VERSION = "evalops.maestro.release-metadata.v1";
const RELEASE_RECEIPT_VERSION = "evalops.maestro.release-receipt.v1";

function parseArgs(argv) {
	const values = {};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (!argument.startsWith("--")) throw new Error(`Unknown argument: ${argument}`);
		const key = argument.slice(2).replaceAll("-", "_");
		values[key] = argv[++index] ?? "";
	}
	for (const field of ["version", "release_tag", "source_sha", "out"]) {
		if (!values[field]?.trim()) throw new Error(`missing required --${field.replaceAll("_", "-")}`);
	}
	if (!/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(values.version.trim())) {
		throw new Error("release version must be semver-like");
	}
	if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(values.release_tag.trim())) {
		throw new Error("release tag must be a v-prefixed semver");
	}
	if (!/^[0-9a-f]{40}$/i.test(values.source_sha.trim())) {
		throw new Error("source SHA must be forty hexadecimal characters");
	}
	return values;
}

function releaseNotesFromChangelog(changelog, version) {
	const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const heading = new RegExp(`^## \\[?${escaped}\\]?(?:\\s+-.*)?$`, "m");
	const match = heading.exec(changelog);
	if (!match) return null;
	const start = match.index + match[0].length;
	const nextHeading = /^## /m.exec(changelog.slice(start));
	const body = changelog.slice(start, nextHeading ? start + nextHeading.index : changelog.length).trim();
	return body || null;
}

export async function buildReleaseMetadata({ version, releaseTag, sourceSha, changelog, passports }) {
	const normalizedVersion = version.replace(/^v/, "");
	return {
		schemaVersion: RELEASE_METADATA_VERSION,
		version: normalizedVersion,
		releaseTag: releaseTag.trim(),
		releaseNotes: releaseNotesFromChangelog(changelog, normalizedVersion),
		receipt: {
			schemaVersion: RELEASE_RECEIPT_VERSION,
			sourceSha: sourceSha.toLowerCase(),
			artifacts: passports
				.map((passport) => ({
					name: passport.artifact?.name,
					digest: passport.artifact?.digest,
					runtimePassport: passport,
				}))
				.sort((left, right) => left.name.localeCompare(right.name)),
		},
	};
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const [changelog, entries] = await Promise.all([
		fs.readFile("CHANGELOG.md", "utf8"),
		fs.readdir(".", { withFileTypes: true }),
	]);
	const passportFiles = entries
		.filter((entry) => entry.isFile() && /^runtime-passport-maestro-.*\.json$/.test(entry.name))
		.map((entry) => entry.name)
		.sort();
	const passports = await Promise.all(
		passportFiles.map(async (file) => JSON.parse(await fs.readFile(join(".", file), "utf8"))),
	);
	if (!passports.length) throw new Error("at least one runtime passport is required");
	const payload = await buildReleaseMetadata({
		version: options.version,
		releaseTag: options.release_tag,
		sourceSha: options.source_sha,
		changelog,
		passports,
	});
	await fs.writeFile(options.out, `${JSON.stringify(payload, null, 2)}\n`);
	console.log(`Wrote release metadata ${basename(options.out)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => {
		console.error(`Failed to create release metadata: ${error.message}`);
		process.exit(1);
	});
}
