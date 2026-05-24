import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePublishedReplayEvidencePath } from "../../scripts/smoke-published-replay-e2e.js";

describe("resolvePublishedReplayEvidencePath", () => {
	it("prefers the explicit evidence path", () => {
		expect(
			resolvePublishedReplayEvidencePath({
				evidencePath: "explicit/evidence.json",
				evidenceDir: "dir",
				env: {
					MAESTRO_PUBLISHED_REPLAY_EVIDENCE_PATH: "env/evidence.json",
					MAESTRO_PUBLISHED_REPLAY_EVIDENCE_DIR: "env-dir",
				},
			}),
		).toBe(resolve("explicit/evidence.json"));
	});

	it("uses the env evidence path before evidence directories", () => {
		expect(
			resolvePublishedReplayEvidencePath({
				evidenceDir: "dir",
				env: {
					MAESTRO_PUBLISHED_REPLAY_EVIDENCE_PATH: "env/evidence.json",
					MAESTRO_PUBLISHED_REPLAY_EVIDENCE_DIR: "env-dir",
				},
			}),
		).toBe(resolve("env/evidence.json"));
	});

	it("writes the default evidence file inside the selected evidence directory", () => {
		expect(
			resolvePublishedReplayEvidencePath({
				evidenceDir: "artifacts",
				env: {
					MAESTRO_PUBLISHED_REPLAY_EVIDENCE_DIR: "env-artifacts",
				},
			}),
		).toBe(join(resolve("artifacts"), "published-replay-evidence.json"));
	});
});
