import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildPublishedReplayEvidence,
	resolvePublishedReplayEvidencePath,
} from "../../scripts/smoke-published-replay-e2e.js";

const rootPackageName = ["@evalops", "maestro"].join("/");

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

	it("includes install metadata in replay evidence", () => {
		expect(
			buildPublishedReplayEvidence({
				packageSpec: `${rootPackageName}@9.9.9`,
				cliCommand: "maestro",
				binPath: "/tmp/project/node_modules/.bin/maestro",
				installMetadata: {
					label: `${rootPackageName}@9.9.9 via npm`,
					name: rootPackageName,
					version: "9.9.9",
					binCommands: ["maestro"],
					forbiddenWorkspaceNames: ["@evalops/contracts", "@evalops/tui"],
					forbiddenReferences: [],
					workspaceProtocolReferences: [],
					installable: true,
					dependencySections: {
						dependencies: [{ name: "zod", spec: "^4.3.6" }],
					},
				},
				modes: [
					{
						mode: "text",
						status: "ok",
						agentRuntimeLedger: {
							schemaVersion: "evalops.maestro.agent-runtime-ledger.v1",
							replayDeterministic: true,
							hasRecordRunWorkItem: true,
							toolWorkItem: {
								toolName: "read",
								evidenceRefs: ["tool-call:call-read-package-json"],
							},
							durability: {
								reconstructable: true,
								sessionFilePresent: true,
								contextManifestPresent: true,
								replayDeterministic: true,
								promotionIdempotencyKey:
									"maestro-local-ledger:session-1:session-1",
							},
						},
					},
				],
			}),
		).toMatchObject({
			schemaVersion: "evalops.maestro.published-replay-evidence.v1",
			package: {
				spec: `${rootPackageName}@9.9.9`,
				installMetadata: {
					installable: true,
					forbiddenReferences: [],
					workspaceProtocolReferences: [],
				},
			},
			modes: [
				{
					agentRuntimeLedger: {
						replayDeterministic: true,
						toolWorkItem: {
							evidenceRefs: ["tool-call:call-read-package-json"],
						},
						durability: {
							reconstructable: true,
							replayDeterministic: true,
						},
					},
				},
			],
		});
	});
});
