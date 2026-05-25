#!/usr/bin/env node
// @ts-check

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function getNpmCommand() {
	return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function getNpxCommand() {
	return process.platform === "win32" ? "npx.cmd" : "npx";
}

export function getBunCommand() {
	return process.platform === "win32" ? "bun.exe" : "bun";
}

export function getBunxCommand() {
	return process.platform === "win32" ? "bunx.exe" : "bunx";
}

export function installedPackageJsonPath(packageName, installRoot) {
	return join(
		installRoot,
		"node_modules",
		...packageName.split("/"),
		"package.json",
	);
}

export function installedBinPath(installRoot, cliCommand) {
	return process.platform === "win32"
		? join(installRoot, "node_modules", ".bin", `${cliCommand}.cmd`)
		: join(installRoot, "node_modules", ".bin", cliCommand);
}

export function readInstalledPackageJson(packageName, installRoot) {
	const packageJsonPath = installedPackageJsonPath(packageName, installRoot);
	try {
		const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("installed package.json did not contain an object");
		}
		return parsed;
	} catch (error) {
		const reason =
			error instanceof Error ? error.message : "unknown package read error";
		throw new Error(
			`Could not read installed package metadata at ${packageJsonPath}: ${reason}`,
		);
	}
}

function stringValue(value) {
	return typeof value === "string" ? value : "";
}

function stringBinCommandName(packageName) {
	const name = stringValue(packageName);
	if (name.startsWith("@")) {
		return name.split("/")[1] ?? "";
	}
	return name;
}

function arrayValues(value) {
	return Array.isArray(value)
		? value.filter((entry) => typeof entry === "string" && entry.length > 0)
		: [];
}

function objectEntries(value) {
	return value && typeof value === "object" && !Array.isArray(value)
		? Object.entries(value)
		: [];
}

export function summarizeInstallablePackageMetadata(
	installedPackage,
	{ label, forbiddenWorkspaceNames = [] },
) {
	const forbiddenNames = new Set(forbiddenWorkspaceNames);
	const forbiddenReferences = [];
	const workspaceProtocolReferences = [];
	const dependencySections = {};
	for (const section of [
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
	]) {
		const entries = objectEntries(installedPackage[section]).sort(([left], [right]) =>
			left.localeCompare(right),
		);
		dependencySections[section] = entries.map(([name, spec]) => ({
			name,
			spec: stringValue(spec),
		}));
		for (const [name, spec] of entries) {
			if (forbiddenNames.has(name)) {
				forbiddenReferences.push(`${section}.${name}`);
			}
			if (typeof spec === "string" && spec.startsWith("workspace:")) {
				workspaceProtocolReferences.push(`${section}.${name}=workspace:`);
			}
		}
	}

	for (const section of ["bundleDependencies", "bundledDependencies"]) {
		const names = arrayValues(installedPackage[section]).sort();
		dependencySections[section] = names;
		for (const name of names) {
			if (forbiddenNames.has(name)) {
				forbiddenReferences.push(`${section}.${name}`);
			}
		}
	}

	const offenders = [...forbiddenReferences, ...workspaceProtocolReferences].sort();
	const binValue = installedPackage.bin;
	const binCommands =
		typeof binValue === "string"
			? [stringBinCommandName(installedPackage.name)].filter(Boolean)
			: objectEntries(binValue)
					.map(([name]) => name)
					.sort();

	return {
		label,
		name: stringValue(installedPackage.name),
		version: stringValue(installedPackage.version),
		binCommands,
		forbiddenWorkspaceNames: [...forbiddenNames].sort(),
		forbiddenReferences: forbiddenReferences.sort(),
		workspaceProtocolReferences: workspaceProtocolReferences.sort(),
		installable: offenders.length === 0,
		dependencySections,
	};
}

export function assertInstallablePackageMetadata(
	installedPackage,
	{ label, forbiddenWorkspaceNames = [] },
) {
	const summary = summarizeInstallablePackageMetadata(installedPackage, {
		label,
		forbiddenWorkspaceNames,
	});
	const offenders = [
		...summary.forbiddenReferences,
		...summary.workspaceProtocolReferences,
	].sort();
	if (offenders.length > 0) {
		throw new Error(
			`${label} exposes non-registry workspace metadata: ${offenders
				.sort()
				.join(", ")}`,
		);
	}
	return summary;
}

export function runInstalledCliSmoke(
	cwd,
	{ cliCommand, expectedVersion, label },
) {
	runCliSmoke(installedBinPath(cwd, cliCommand), [], cwd, {
		cliCommand,
		expectedVersion,
		label,
	});
}

function runCliSmoke(command, prefixArgs, cwd, { cliCommand, expectedVersion, label }) {
	const versionOutput = execFileSync(command, [...prefixArgs, "--version"], {
		cwd,
		encoding: "utf8",
	});
	if (!versionOutput.includes(expectedVersion)) {
		throw new Error(
			`Expected ${label} ${cliCommand} --version output to include ${expectedVersion}, received: ${versionOutput.trim()}`,
		);
	}

	execFileSync(command, [...prefixArgs, "--help"], {
		cwd,
		stdio: "ignore",
	});
}

export function runNpxCliSmoke(cwd, { cliCommand, expectedVersion, label }) {
	runCliSmoke(getNpxCommand(), ["--no-install", cliCommand], cwd, {
		cliCommand,
		expectedVersion,
		label,
	});
}

export function runBunxCliSmoke(cwd, { cliCommand, expectedVersion, label }) {
	runCliSmoke(getBunxCommand(), [cliCommand], cwd, {
		cliCommand,
		expectedVersion,
		label,
	});
}

function parseAuditJson(output) {
	try {
		return JSON.parse(output);
	} catch {
		return null;
	}
}

function formatVulnerabilitySummary(report) {
	const counts = report?.metadata?.vulnerabilities;
	if (!counts || typeof counts !== "object") {
		return "unknown vulnerability counts";
	}

	return [
		`info=${counts.info ?? 0}`,
		`low=${counts.low ?? 0}`,
		`moderate=${counts.moderate ?? 0}`,
		`high=${counts.high ?? 0}`,
		`critical=${counts.critical ?? 0}`,
	]
		.join(", ");
}

/**
 * @param {string} cwd
 * @param {{label: string; auditLevel?: string}} options
 */
export function runInstalledPackageAudit(
	cwd,
	{ label, auditLevel = process.env.MAESTRO_INSTALL_AUDIT_LEVEL ?? "high" },
) {
	if (
		process.env.MAESTRO_SKIP_INSTALL_AUDIT === "1" ||
		!auditLevel ||
		auditLevel === "none"
	) {
		console.log(`Skipping installed package audit for ${label}.`);
		return;
	}

	const npmCommand = getNpmCommand();

	try {
		const output = execFileSync(
			npmCommand,
			["audit", "--omit=dev", "--audit-level", auditLevel, "--json"],
			{
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const report = parseAuditJson(output);
		console.log(
			`Installed package audit passed for ${label} (${formatVulnerabilitySummary(report)}).`,
		);
	} catch (error) {
		const stdout =
			error && typeof error === "object" && "stdout" in error
				? String(error.stdout ?? "")
				: "";
		const stderr =
			error && typeof error === "object" && "stderr" in error
				? String(error.stderr ?? "")
				: "";
		const report =
			parseAuditJson(stdout) ??
			parseAuditJson(stderr) ?? { metadata: { vulnerabilities: {} } };
		console.error(
			`Installed package audit failed for ${label} at level ${auditLevel}: ${formatVulnerabilitySummary(report)}`,
		);
		const vulnerabilities =
			report && report.vulnerabilities && typeof report.vulnerabilities === "object"
				? report.vulnerabilities
				: {};
		for (const [name, details] of Object.entries(vulnerabilities)) {
			if (!details || typeof details !== "object") {
				continue;
			}
			const severity =
				"severity" in details && typeof details.severity === "string"
					? details.severity
					: "unknown";
			const via =
				Array.isArray(details.via) && details.via.length > 0
					? details.via
							.map((entry) =>
								typeof entry === "string"
									? entry
									: entry && typeof entry === "object" && "name" in entry
										? String(entry.name)
										: "unknown",
							)
							.join(", ")
					: "direct";
			console.error(`- ${name}: ${severity} (${via})`);
		}
		throw new Error(`Installed package audit failed for ${label}`);
	}
}
