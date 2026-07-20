#!/usr/bin/env node
/**
 * Canary: fail if GitHub Actions pipelines TLS cert is expired or near expiry.
 * 2026-07-19 outage: pipelines leaf expired and all self-hosted runners dropped offline.
 *
 * Usage:
 *   node scripts/check-actions-pipelines-cert.mjs
 *   node scripts/check-actions-pipelines-cert.mjs --warn-days 14 --fail-days 3
 */
import tls from "node:tls";

function parseArgs(argv) {
	let warnDays = 14;
	let failDays = 2;
	let host = "pipelines.actions.githubusercontent.com";
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a === "--warn-days") warnDays = Number(argv[++i]);
		else if (a === "--fail-days") failDays = Number(argv[++i]);
		else if (a === "--host") host = argv[++i];
		else if (a === "--help" || a === "-h") {
			console.log(
				"Usage: check-actions-pipelines-cert.mjs [--warn-days N] [--fail-days N] [--host host]",
			);
			process.exit(0);
		}
	}
	if (!Number.isFinite(warnDays) || !Number.isFinite(failDays)) {
		throw new Error("warn-days and fail-days must be numbers");
	}
	return { warnDays, failDays, host };
}

function fetchCertificate(host, port = 443) {
	return new Promise((resolve, reject) => {
		const socket = tls.connect(
			{
				host,
				port,
				servername: host,
				// We intentionally inspect whatever the server presents, including expired.
				rejectUnauthorized: false,
			},
			() => {
				const cert = socket.getPeerCertificate();
				socket.end();
				if (!cert || !cert.valid_to) {
					reject(new Error(`No peer certificate from ${host}`));
					return;
				}
				resolve(cert);
			},
		);
		socket.setTimeout(15_000, () => {
			socket.destroy(new Error(`TLS connect timeout to ${host}`));
		});
		socket.on("error", reject);
	});
}

async function main() {
	const { warnDays, failDays, host } = parseArgs(process.argv.slice(2));
	const cert = await fetchCertificate(host);
	const notAfter = new Date(cert.valid_to);
	const notBefore = new Date(cert.valid_from);
	const now = new Date();
	const msLeft = notAfter.getTime() - now.getTime();
	const daysLeft = msLeft / (1000 * 60 * 60 * 24);

	const summary = {
		host,
		subject: cert.subject?.CN ?? cert.subject,
		issuer: cert.issuer?.CN ?? cert.issuer,
		notBefore: notBefore.toISOString(),
		notAfter: notAfter.toISOString(),
		daysLeft: Number(daysLeft.toFixed(3)),
		warnDays,
		failDays,
	};
	console.log(JSON.stringify(summary, null, 2));

	if (msLeft <= 0) {
		console.error(
			`FAIL: ${host} certificate expired at ${notAfter.toISOString()} (${Math.abs(daysLeft).toFixed(2)} days ago). Self-hosted Actions runners will fail SSL (NotTimeValid).`,
		);
		process.exit(2);
	}
	if (daysLeft <= failDays) {
		console.error(
			`FAIL: ${host} certificate expires in ${daysLeft.toFixed(2)} days (threshold ${failDays}). Renew/rotate urgently.`,
		);
		process.exit(1);
	}
	if (daysLeft <= warnDays) {
		console.warn(
			`WARN: ${host} certificate expires in ${daysLeft.toFixed(2)} days (warn threshold ${warnDays}).`,
		);
	} else {
		console.log(
			`OK: ${host} certificate valid for ${daysLeft.toFixed(2)} more days.`,
		);
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
