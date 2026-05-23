import { describe, expect, it } from "vitest";
import {
	buildPublicMirrorSourceMarker,
	evaluatePublicMirrorSource,
	parsePublicMirrorSourceMarker,
} from "../../scripts/public-mirror-source.mjs";

describe("public mirror source metadata", () => {
	it("builds and parses a machine-readable source marker", () => {
		const marker = buildPublicMirrorSourceMarker({
			scope: "public-tree",
			sourceRepo: "evalops/maestro-internal",
			sourceSha: "0123456789abcdef0123456789abcdef01234567",
		});

		expect(marker).toContain("maestro-public-mirror-source");
		expect(parsePublicMirrorSourceMarker(`body\n${marker}\nmore`)).toEqual({
			schemaVersion: 1,
			scope: "public-tree",
			sourceRepo: "evalops/maestro-internal",
			sourceSha: "0123456789abcdef0123456789abcdef01234567",
		});
	});

	it("rejects stale generated public mirror PR bodies", () => {
		const body = buildPublicMirrorSourceMarker({
			scope: "public-tree",
			sourceRepo: "evalops/maestro-internal",
			sourceSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		});

		expect(
			evaluatePublicMirrorSource({
				body,
				expectedScope: "public-tree",
				expectedSourceRepo: "evalops/maestro-internal",
				expectedSourceSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			}),
		).toMatchObject({
			ok: false,
			reason: "source_sha_mismatch",
		});
	});
});
