import assert from "node:assert/strict";
import { test } from "node:test";
import { channelRelease } from "./channel-version.mjs";

test("alpha stays one patch line ahead of beta", () => {
	assert.deepEqual(
		channelRelease({ stableVersion: "0.11.7", channel: "beta", ordinal: 42 }),
		{ channel: "beta", sourceOffset: 1, version: "0.11.8-beta.42" },
	);
	assert.deepEqual(
		channelRelease({ stableVersion: "0.11.7", channel: "alpha", ordinal: 42 }),
		{ channel: "alpha", sourceOffset: 0, version: "0.11.9-alpha.42" },
	);
});

test("rejects unstable bases, unknown channels, and invalid ordinals", () => {
	assert.throws(
		() => channelRelease({ stableVersion: "0.11.7-beta.1", channel: "beta", ordinal: 1 }),
		/plain semver/,
	);
	assert.throws(
		() => channelRelease({ stableVersion: "0.11.7", channel: "nightly", ordinal: 1 }),
		/alpha or beta/,
	);
	assert.throws(
		() => channelRelease({ stableVersion: "0.11.7", channel: "alpha", ordinal: 0 }),
		/positive integer/,
	);
});
