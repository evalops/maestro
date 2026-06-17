import { describe, expect, it, vi } from "vitest";
import {
	SECRET_SCRUBBER_FAILURE_PLACEHOLDER,
	SECRET_STREAM_BOUNDARY_PLACEHOLDER,
	SecretOutputScrubber,
	SecretScrubberError,
	scrubOutputFailClosed,
} from "../../src/tools/output-scrubber.js";

const joinParts = (...parts: string[]) => parts.join("");
const SAMPLE_SECRET = joinParts(
	"ghp",
	"_",
	"abcdefghijklmnopqrstuvwxyz",
	"ABCDEFGHIJ",
);

describe("output scrubber", () => {
	it("replaces failed scrub windows without emitting raw output", () => {
		const onFailure = vi.fn();
		const scrubber = new SecretOutputScrubber({
			windowSize: 0,
			scrubber: () => {
				throw new Error("regex engine exploded");
			},
			onFailure,
		});

		const output = scrubber.write(`token ${SAMPLE_SECRET}`);

		expect(output).toBe(SECRET_SCRUBBER_FAILURE_PLACEHOLDER);
		expect(output).not.toContain(SAMPLE_SECRET);
		expect(onFailure).toHaveBeenCalledOnce();
	});

	it("throws in strict mode without returning raw output", () => {
		expect(() =>
			scrubOutputFailClosed(`token ${SAMPLE_SECRET}`, {
				strict: true,
				scrubber: () => {
					throw new Error("bad pattern");
				},
			}),
		).toThrow(SecretScrubberError);
	});

	it("holds a trailing window so split credentials are scrubbed before flush", () => {
		const scrubber = new SecretOutputScrubber({ windowSize: 64 });

		const first = scrubber.write(SAMPLE_SECRET.slice(0, 12));
		const second = scrubber.write(SAMPLE_SECRET.slice(12));
		const flushed = scrubber.flush();
		const output = `${first}${second}${flushed}`;

		expect(output).toContain("[secret]");
		expect(output).not.toContain(SAMPLE_SECRET);
	});

	it("does not emit partial token fragments at streaming boundaries", () => {
		const longSecret = joinParts("ghp_", "a".repeat(80));
		const scrubber = new SecretOutputScrubber({ windowSize: 16 });

		const first = scrubber.write(`prefix ${longSecret.slice(0, 48)}`);
		const second = scrubber.write(`${longSecret.slice(48)} suffix`);
		const flushed = scrubber.flush();
		const output = `${first}${second}${flushed}`;

		expect(`${first}${second}`).not.toContain(longSecret.slice(0, 24));
		expect(output).toContain("[secret]");
		expect(output).not.toContain(longSecret);
	});

	it("redacts oversized unbroken spans when no safe boundary is available", () => {
		const scrubber = new SecretOutputScrubber({
			maxPendingChars: 32,
			windowSize: 8,
		});

		const output = scrubber.write("x".repeat(40));

		expect(output).toBe(SECRET_STREAM_BOUNDARY_PLACEHOLDER);
	});
});
