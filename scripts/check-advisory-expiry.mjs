#!/usr/bin/env node

/**
 * Advisory ignore-list expiry invariant.
 *
 * `cargo-deny` has no native expiry mechanism for `advisories.ignore`
 * entries: once an advisory ID is listed there, it stays silently accepted
 * forever unless a human happens to notice and remove it. This script is
 * the out-of-band enforcement that makes the "reason + expiry" convention
 * documented in deny.toml actually load-bearing:
 *
 * - Every `advisories.ignore` entry MUST be the `{ id = "...", reason = "..." }`
 *   object form (not a bare string), and its `reason` MUST contain an
 *   `expires: YYYY-MM-DD` marker.
 * - This check fails the build if any listed advisory's `expires:` date has
 *   passed, forcing a conscious re-review (bump the dependency and drop the
 *   entry, or extend the expiry with a fresh reason) instead of an advisory
 *   riding along unreviewed indefinitely.
 * - This check also fails if an entry is missing the marker entirely, so the
 *   convention can't quietly be dropped by a future edit.
 *
 * This intentionally does not parse full TOML (no parser dependency): the
 * `advisories.ignore` array in deny.toml is hand-written and constrained to
 * one inline-table entry per line, so a line-oriented scan is sufficient and
 * keeps this script dependency-free.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const defaultDenyTomlPath = fileURLToPath(new URL("../deny.toml", import.meta.url));

const INLINE_TABLE_RE = /^\s*\{(.*)\}\s*,?\s*$/u;
const INLINE_FIELD_RE =
	/(?:^|,)\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?=,|$)/gu;
const EXPIRES_RE = /expires:\s*(\d{4}-\d{2}-\d{2})/;
const BARE_ID_RE = /^\s*"RUSTSEC-[0-9-]+"\s*,?\s*$/u;

export function extractIgnoreEntries(denyTomlText) {
	const advisoriesStart = denyTomlText.indexOf("[advisories]");
	if (advisoriesStart === -1) {
		throw new Error("deny.toml has no [advisories] section");
	}
	const sectionStart = advisoriesStart + "[advisories]".length;
	const sectionTail = denyTomlText.slice(sectionStart);
	const nextSection = sectionTail.match(/^\s*\[[^\]\r\n]+\]\s*$/mu);
	const sectionText =
		nextSection === null ? sectionTail : sectionTail.slice(0, nextSection.index);
	const ignoreMatch = sectionText.match(/^\s*ignore\s*=\s*(\[)/mu);
	if (ignoreMatch === null) {
		throw new Error("deny.toml [advisories] section has no `ignore` list");
	}
	const listStart =
		sectionStart + ignoreMatch.index + ignoreMatch[0].lastIndexOf(ignoreMatch[1]);
	if (/^\[\s*\]/u.test(denyTomlText.slice(listStart))) {
		return { entries: [], bareIds: [], unparsedEntries: [] };
	}
	const listEnd = denyTomlText.indexOf("\n]", listStart);
	if (listEnd === -1) {
		throw new Error("could not find the bounds of advisories.ignore = [ ... ]");
	}
	const listText = denyTomlText.slice(listStart, listEnd);

	const entries = [];
	const bareIds = [];
	const unparsedEntries = [];
	for (const rawLine of listText.split("\n")) {
		const line = rawLine.trim();
		if (line === "" || line === "[" || line.startsWith("#")) continue;
		if (BARE_ID_RE.test(line)) {
			bareIds.push(line);
			continue;
		}

		const tableMatch = line.match(INLINE_TABLE_RE);
		if (!tableMatch) {
			unparsedEntries.push(line);
			continue;
		}

		const tableBody = tableMatch[1];
		const fields = new Map();
		const spans = [];
		let duplicateField = false;
		for (const fieldMatch of tableBody.matchAll(INLINE_FIELD_RE)) {
			if (fields.has(fieldMatch[1])) duplicateField = true;
			fields.set(fieldMatch[1], fieldMatch[2]);
			spans.push([fieldMatch.index, fieldMatch.index + fieldMatch[0].length]);
		}
		let unmatched = tableBody;
		for (const [start, end] of spans.reverse()) {
			unmatched = `${unmatched.slice(0, start)}${unmatched.slice(end)}`;
		}
		const hasOnlyExpectedFields =
			fields.size === 2 && fields.has("id") && fields.has("reason");
		if (
			duplicateField ||
			!hasOnlyExpectedFields ||
			unmatched.replaceAll(",", "").trim() !== ""
		) {
			unparsedEntries.push(line);
			continue;
		}
		entries.push({ id: fields.get("id"), reason: fields.get("reason") });
	}

	return { entries, bareIds, unparsedEntries };
}

export function evaluateAdvisoryExpiry(denyTomlText, { now = new Date() } = {}) {
	const { entries, bareIds, unparsedEntries } = extractIgnoreEntries(denyTomlText);
	const failures = [];

	for (const bareId of bareIds) {
		failures.push(
			`${bareId} is a bare-string ignore entry with no reason/expiry. ` +
				`Use { id = "...", reason = "...; expires: YYYY-MM-DD" } instead.`,
		);
	}

	for (const unparsedEntry of unparsedEntries) {
		failures.push(
			`Unparseable advisories.ignore entry: ${unparsedEntry}. ` +
				'Use one inline table per line with exactly id = "..." and reason = "...; expires: YYYY-MM-DD".',
		);
	}

	for (const entry of entries) {
		const expiresMatch = entry.reason.match(EXPIRES_RE);
		if (!expiresMatch) {
			failures.push(
				`${entry.id}'s ignore reason has no "expires: YYYY-MM-DD" marker: "${entry.reason}"`,
			);
			continue;
		}
		const expires = new Date(`${expiresMatch[1]}T00:00:00Z`);
		if (
			Number.isNaN(expires.getTime()) ||
			expires.toISOString().slice(0, 10) !== expiresMatch[1]
		) {
			failures.push(`${entry.id} has an unparseable expiry date: "${expiresMatch[1]}"`);
			continue;
		}
		const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
		if (expires.getTime() < todayUtc) {
			failures.push(
				`${entry.id}'s ignore entry expired on ${expiresMatch[1]}. ` +
					`Re-review: bump the dependency and drop the entry, or extend the expiry with a fresh reason.`,
			);
		}
	}

	return { failures, entries };
}

function main() {
	const path = process.argv[2] ?? defaultDenyTomlPath;
	const denyTomlText = readFileSync(path, "utf8");
	const { failures, entries } = evaluateAdvisoryExpiry(denyTomlText);

	if (failures.length === 0) {
		console.log(
			`Advisory ignore-list expiry check passed (${entries.length} accepted advisor${entries.length === 1 ? "y" : "ies"}, none expired).`,
		);
		return;
	}

	for (const failure of failures) {
		console.error(`::error::${failure}`);
	}
	process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
