import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateAdvisoryExpiry, extractIgnoreEntries } from "./check-advisory-expiry.mjs";

function denyToml(ignoreBody) {
	return `[advisories]\nignore = [\n${ignoreBody}\n]\n\n[licenses]\nallow = ["MIT"]\n`;
}

const fixedNow = new Date("2026-07-25T00:00:00Z");

test("inline empty ignore list passes", () => {
	const text = '[advisories]\nignore = []\n\n[licenses]\nallow = ["MIT"]\n';
	const result = evaluateAdvisoryExpiry(text, { now: fixedNow });
	assert.deepEqual(result, { failures: [], entries: [] });
});

test("commented empty-list examples cannot hide the active ignore list", () => {
	const text =
		'[advisories]\n' +
		'# Prior state: ignore = []\n' +
		'ignore = [\n' +
		'    { id = "RUSTSEC-2025-0141", reason = "expired. expires: 2020-01-01" },\n' +
		']\n\n' +
		'[licenses]\nallow = ["MIT"]\n';
	const { failures, entries } = evaluateAdvisoryExpiry(text, { now: fixedNow });
	assert.equal(entries.length, 1);
	assert.equal(failures.length, 1);
	assert.match(failures[0], /expired on 2020-01-01/u);
});

test("entry with a future expiry passes", () => {
	const text = denyToml(
		'    { id = "RUSTSEC-2025-0141", reason = "unmaintained, dev-only. expires: 2026-10-23" },',
	);
	const { failures } = evaluateAdvisoryExpiry(text, { now: fixedNow });
	assert.deepEqual(failures, []);
});

test("entry remains valid throughout its UTC expiry date", () => {
	const text = denyToml(
		'    { id = "RUSTSEC-2025-0141", reason = "unmaintained, dev-only. expires: 2026-07-25" },',
	);
	const { failures } = evaluateAdvisoryExpiry(text, {
		now: new Date("2026-07-25T23:59:59Z"),
	});
	assert.deepEqual(failures, []);
});

test("entry with a past expiry fails", () => {
	const text = denyToml(
		'    { id = "RUSTSEC-2025-0141", reason = "unmaintained, dev-only. expires: 2026-01-01" },',
	);
	const { failures } = evaluateAdvisoryExpiry(text, { now: fixedNow });
	assert.equal(failures.length, 1);
	assert.match(failures[0], /RUSTSEC-2025-0141/u);
	assert.match(failures[0], /expired on 2026-01-01/u);
});

test("entry missing an expires marker fails", () => {
	const text = denyToml('    { id = "RUSTSEC-2025-0141", reason = "just unmaintained, no rush" },');
	const { failures } = evaluateAdvisoryExpiry(text, { now: fixedNow });
	assert.equal(failures.length, 1);
	assert.match(failures[0], /no "expires: YYYY-MM-DD" marker/u);
});

test("calendar-invalid expiry dates fail closed", () => {
	const text = denyToml(
		'    { id = "RUSTSEC-2025-0141", reason = "unmaintained, no fix yet. expires: 2026-02-30" },',
	);
	const { failures } = evaluateAdvisoryExpiry(text, { now: fixedNow });
	assert.equal(failures.length, 1);
	assert.match(failures[0], /unparseable expiry date/u);
});

test("entry fields may be reordered without bypassing expiry enforcement", () => {
	const text = denyToml(
		'    { reason = "unmaintained, no fix yet. expires: 2026-10-23", id = "RUSTSEC-2025-0141" },',
	);
	const { failures, entries } = evaluateAdvisoryExpiry(text, { now: fixedNow });
	assert.deepEqual(failures, []);
	assert.deepEqual(entries, [
		{
			id: "RUSTSEC-2025-0141",
			reason: "unmaintained, no fix yet. expires: 2026-10-23",
		},
	]);
});

test("unparsed inline-table entries fail closed", () => {
	const text = denyToml(
		'    { id = "RUSTSEC-2025-0141", note = "wrong key. expires: 2026-10-23" },',
	);
	const { failures, entries } = evaluateAdvisoryExpiry(text, { now: fixedNow });
	assert.deepEqual(entries, []);
	assert.equal(failures.length, 1);
	assert.match(failures[0], /Unparseable advisories\.ignore entry/u);
});

test("bare string ignore entry (no reason/expiry) fails", () => {
	const text = denyToml('    "RUSTSEC-2025-0141",');
	const { failures } = evaluateAdvisoryExpiry(text, { now: fixedNow });
	assert.equal(failures.length, 1);
	assert.match(failures[0], /bare-string ignore entry/u);
});

test("multiple entries are all evaluated independently", () => {
	const text = denyToml(
		[
			'    { id = "RUSTSEC-2025-0141", reason = "ok one. expires: 2026-10-23" },',
			'    { id = "RUSTSEC-2024-0436", reason = "expired one. expires: 2020-01-01" },',
		].join("\n"),
	);
	const { failures, entries } = evaluateAdvisoryExpiry(text, { now: fixedNow });
	assert.equal(entries.length, 2);
	assert.equal(failures.length, 1);
	assert.match(failures[0], /RUSTSEC-2024-0436/u);
});

test("extractIgnoreEntries parses id and reason for a real-shaped list", () => {
	const text = denyToml(
		[
			'    { id = "RUSTSEC-2025-0141", reason = "bincode unmaintained; via syntect. expires: 2026-10-23" },',
			'    { id = "RUSTSEC-2026-0002", reason = "lru unsound; via ratatui. expires: 2026-10-23" },',
		].join("\n"),
	);
	const { entries, bareIds } = extractIgnoreEntries(text);
	assert.equal(entries.length, 2);
	assert.equal(bareIds.length, 0);
	assert.equal(entries[0].id, "RUSTSEC-2025-0141");
	assert.match(entries[1].reason, /lru unsound/u);
});
