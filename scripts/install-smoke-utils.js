#!/usr/bin/env node
// @ts-check

import { execFileSync } from "node:child_process";

export function getNpmCommand() {
	return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function getNpxCommand() {
	return process.platform === "win32" ? "npx.cmd" : "npx";
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
