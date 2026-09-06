#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

export function parseCodesignDetails(output) {
	const details = { authorities: [] };
	for (const line of String(output ?? "").split(/\r?\n/)) {
		const match = /^([^=]+)=(.*)$/.exec(line.trim());
		if (!match) continue;
		const [, key, value] = match;
		if (key === "Authority") details.authorities.push(value);
		else details[key] = value;
	}
	return details;
}

export function validateDeveloperIdSignature(details, { expectedTeamIdentifier = "", expectedAuthority = "" } = {}) {
	const authorities = Array.isArray(details?.authorities) ? details.authorities : [];
	const authority = authorities.find((value) => /^Developer ID Application: .+/.test(value));
	if (!authority) throw new Error("macOS release binary lacks a Developer ID Application authority");
	if (String(details?.Signature ?? "").toLowerCase().includes("adhoc")) {
		throw new Error("macOS release binary has an ad-hoc signature");
	}
	const teamIdentifier = String(details?.TeamIdentifier ?? "");
	if (!/^[A-Z0-9]{10}$/.test(teamIdentifier)) {
		throw new Error("macOS release binary lacks a stable ten-character TeamIdentifier");
	}
	if (expectedTeamIdentifier && teamIdentifier !== expectedTeamIdentifier) {
		throw new Error("macOS release binary TeamIdentifier does not match the release identity");
	}
	if (expectedAuthority && authority !== expectedAuthority) {
		throw new Error("macOS release binary Developer ID authority does not match the release identity");
	}
	if (details?.Identifier !== "maestro") {
		throw new Error("macOS release binary identifier must remain maestro to preserve Keychain access");
	}
	return {
		authority,
		teamIdentifier,
		identifier: details.Identifier,
		codeDirectoryHash: details?.CDHash || null,
	};
}

function runCodesign(args, binary) {
	const result = spawnSync("codesign", args, { encoding: "utf8" });
	if (result.error) throw new Error(`codesign is unavailable for ${basename(binary)}`);
	if (result.status !== 0) {
		throw new Error(`codesign rejected ${basename(binary)}: ${String(result.stderr || result.stdout).trim()}`);
	}
	return `${result.stdout}\n${result.stderr}`;
}

export function inspectMacosReleaseSignature(binary, options = {}) {
	const resolved = resolve(binary);
	if (process.platform !== "darwin" && options.allowNonMacos !== true) {
		throw new Error("macOS release signature acceptance must run on a macOS runner");
	}
	runCodesign(["--verify", "--strict", "--deep", resolved], resolved);
	const details = parseCodesignDetails(runCodesign(["-dv", "--verbose=4", resolved], resolved));
	return buildMacosReleaseSignatureMarker(resolved, details, options);
}

export function buildMacosReleaseSignatureMarker(binary, details, options = {}) {
	const resolved = resolve(binary);
	return {
		schema: "evalops.maestro.macos-release-signature.v1",
		binary: basename(resolved),
		binarySha256: createHash("sha256").update(readFileSync(resolved)).digest("hex"),
		...validateDeveloperIdSignature(details, options),
	};
}

function main(argv = process.argv.slice(2), env = process.env) {
	const binary = argv.find((value) => !value.startsWith("--"));
	if (!binary) throw new Error("usage: check-macos-release-signature.mjs <installed-maestro-binary> [--marker path]");
	const markerIndex = argv.indexOf("--marker");
	const markerPath = markerIndex >= 0 ? argv[markerIndex + 1] : "";
	if (markerIndex >= 0 && !markerPath) throw new Error("--marker requires an output path");
	const result = inspectMacosReleaseSignature(binary, {
		expectedTeamIdentifier: env.MAESTRO_RELEASE_DEVELOPER_ID_TEAM_IDENTIFIER?.trim() || "",
		expectedAuthority: env.MAESTRO_RELEASE_DEVELOPER_ID_AUTHORITY?.trim() || "",
	});
	if (markerPath) writeFileSync(resolve(markerPath), `${JSON.stringify(result)}\n`);
	console.log(JSON.stringify({ status: "passed", ...result }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
