import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPublishedReplayEvidence } from "../../scripts/smoke-published-replay-e2e.js";
import {
	expectedPublishedReplayEvidenceFiles,
	validatePublishedReplayEvidence,
	validatePublishedReplayEvidenceSet,
} from "../../scripts/verify-published-replay-evidence.js";

const rootPackageName = ["@evalops", "maestro"].join("/");
const digest = "a".repeat(64);

function makeReplayMode(mode: "text" | "json" | "rpc") {
	return {
		mode,
		status: "ok",
		provider: "scripted-replay",
		tool: {
			name: "read",
			callId: "call-read-package-json",
			inputPath: "package.json",
			resultStatus: "success",
		},
		final: {
			status: "ok",
			containsExpectedText: true,
		},
		session: {
			sessionId: `session-${mode}`,
			jsonlFileCount: 1,
			bytes: 256,
			sha256: digest,
			containsFinalText: true,
			containsToolCallId: true,
			containsWriteToolCallId: true,
		},
		agentRuntimeLedger: {
			schemaVersion: "evalops.maestro.agent-runtime-ledger.v1",
			replayDeterministic: true,
			entries: 4,
			promotionOperations: 6,
			counts: {
				entries: 4,
				promotionOperations: 6,
				byKind: {
					run: 1,
					tool_call: 1,
					tool_result: 1,
					runtime: 1,
				},
				byState: {
					running: 1,
					succeeded: 3,
				},
			},
			hasHandleTrigger: true,
			hasRecordRunStep: true,
			hasRecordRunWorkItem: true,
			hasTerminalOperation: true,
			toolWorkItem: {
				toolName: "read",
				toolCallId: "call-read-package-json",
				evidenceRefs: [
					"tool-call:call-read-package-json",
					`tool-execution:tool-exec-${mode}`,
				],
				completionGate: "maestro_agent_runtime_ledger_recorded",
			},
			toolWorkItems: [
				{
					toolName: "read",
					toolCallId: "call-read-package-json",
					evidenceRefs: [
						"tool-call:call-read-package-json",
						`tool-execution:tool-exec-${mode}`,
					],
					completionGate: "maestro_agent_runtime_ledger_recorded",
				},
				{
					toolName: "write",
					toolCallId: "call-write-published-artifact",
					evidenceRefs: [
						"tool-call:call-write-published-artifact",
						`approval-request:approval-${mode}`,
						`artifact:artifact-${mode}`,
					],
					completionGate: "maestro_agent_runtime_ledger_recorded",
				},
			],
			durability: {
				reconstructable: true,
				sessionFilePresent: true,
				contextManifestPresent: true,
				replayDeterministic: true,
				promotionIdempotencyKey: `maestro-local-ledger:session-${mode}:session-${mode}`,
			},
		},
	};
}

function makeEvidence(installer: "npm" | "bun" = "npm") {
	const installLabel = installer === "bun" ? "via Bun" : "via npm";
	return buildPublishedReplayEvidence({
		packageSpec: `${rootPackageName}@9.9.9`,
		cliCommand: "maestro",
		binPath: "/tmp/project/node_modules/.bin/maestro",
		installer,
		installMetadata: {
			label: `${rootPackageName}@9.9.9 ${installLabel}`,
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
			makeReplayMode("text"),
			makeReplayMode("json"),
			makeReplayMode("rpc"),
		],
	});
}

function useSharedWriteEvidenceRefs(evidence: ReturnType<typeof makeEvidence>) {
	const sharedRefs = [
		"tool-call:call-write-published-artifact",
		"approval-request:call-write-published-artifact",
		"artifact:file:published-replay-artifact.json",
	];
	for (const mode of evidence.modes) {
		const writeItem = mode.agentRuntimeLedger.toolWorkItems.find(
			(item) => item.toolName === "write",
		);
		if (!writeItem) {
			throw new Error("Expected write tool work item in replay fixture");
		}
		writeItem.evidenceRefs = sharedRefs;
	}
	evidence.observability.approvals = {
		count: 1,
		evidenceRefs: ["approval-request:call-write-published-artifact"],
	};
	evidence.observability.artifacts = {
		count: 1,
		evidenceRefs: ["artifact:file:published-replay-artifact.json"],
	};
	return evidence;
}

function withTempDir(run: (dir: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), "maestro-published-evidence-"));
	try {
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("verify-published-replay-evidence", () => {
	it("maps npm and Bun evidence files from a directory", () => {
		expect(
			expectedPublishedReplayEvidenceFiles({
				evidenceDir: "artifacts",
				installers: ["npm", "bun"],
			}).map((entry) => entry.path.replace(process.cwd(), "")),
		).toEqual([
			"/artifacts/npm-published-replay-evidence.json",
			"/artifacts/bun-published-replay-evidence.json",
		]);
	});

	it("accepts evidence that satisfies the release gate and observability contract", () => {
		expect(validatePublishedReplayEvidence(makeEvidence())).toMatchObject({
			packageSpec: `${rootPackageName}@9.9.9`,
			cliCommand: "maestro",
			modes: ["json", "rpc", "text"],
		});
	});

	it("accepts shared approval and artifact refs when each replay mode carries them", () => {
		expect(
			validatePublishedReplayEvidence(
				useSharedWriteEvidenceRefs(makeEvidence()),
			),
		).toMatchObject({
			packageSpec: `${rootPackageName}@9.9.9`,
			cliCommand: "maestro",
			modes: ["json", "rpc", "text"],
		});
	});

	it("fails when install metadata does not match the published package spec", () => {
		const evidence = makeEvidence();
		evidence.package.installMetadata.name = "@evalops/not-maestro";
		evidence.package.installMetadata.version = "0.0.0";

		expect(() => validatePublishedReplayEvidence(evidence)).toThrow(
			/package\.installMetadata\.name.*package\.installMetadata\.version/s,
		);
	});

	it("fails when approval or artifact trace evidence is missing", () => {
		const evidence = makeEvidence();
		for (const mode of evidence.modes) {
			const workItems = [
				mode.agentRuntimeLedger.toolWorkItem,
				...mode.agentRuntimeLedger.toolWorkItems,
			];
			for (const workItem of workItems) {
				workItem.evidenceRefs = workItem.evidenceRefs.filter(
					(ref: string) =>
						!ref.startsWith("approval-request:") &&
						!ref.startsWith("artifact:"),
				);
			}
		}
		evidence.observability.approvals = {
			count: 0,
			evidenceRefs: [],
		};
		evidence.observability.artifacts = {
			count: 0,
			evidenceRefs: [],
		};
		evidence.releaseGate.checks.approvalTraceEvidence = false;
		evidence.releaseGate.checks.artifactTraceEvidence = false;
		evidence.releaseGate.satisfied = false;
		evidence.releaseGate.failedChecks = [
			"approvalTraceEvidence",
			"artifactTraceEvidence",
		];

		expect(() => validatePublishedReplayEvidence(evidence)).toThrow(
			/approvalTraceEvidence.*artifactTraceEvidence.*observability\.approvals.*observability\.artifacts/s,
		);
	});

	it("fails when approval or artifact release-gate checks are absent", () => {
		const evidence = makeEvidence();
		delete evidence.releaseGate.checks.approvalTraceEvidence;
		delete evidence.releaseGate.checks.artifactTraceEvidence;

		expect(() => validatePublishedReplayEvidence(evidence)).toThrow(
			/releaseGate\.checks\.approvalTraceEvidence.*releaseGate\.checks\.artifactTraceEvidence/s,
		);
	});

	it("fails when provider config or transcript evidence is missing", () => {
		const evidence = makeEvidence();
		delete evidence.replay.providerConfig;
		delete evidence.transcript;
		delete evidence.observability.providerConfig;
		delete evidence.observability.transcript;
		delete evidence.releaseGate.checks.providerConfig;
		delete evidence.releaseGate.checks.transcriptEvidence;

		expect(() => validatePublishedReplayEvidence(evidence)).toThrow(
			/releaseGate\.checks\.providerConfig.*releaseGate\.checks\.transcriptEvidence.*replay\.providerConfig.*transcript/s,
		);
	});

	it("fails when provider config is not deterministic", () => {
		const evidence = makeEvidence();
		evidence.replay.providerConfig.deterministic = false;
		evidence.observability.providerConfig.deterministic = false;

		expect(() => validatePublishedReplayEvidence(evidence)).toThrow(
			/replay\.providerConfig.*observability\.providerConfig/s,
		);
	});

	it("fails when observability provider config diverges from replay provider config", () => {
		const evidence = makeEvidence();
		const divergentSandboxMode =
			evidence.replay.providerConfig.sandboxMode === "danger-full-access"
				? "workspace-write"
				: "danger-full-access";
		evidence.observability.providerConfig = {
			...evidence.observability.providerConfig,
			sandboxMode: divergentSandboxMode,
		};

		expect(() => validatePublishedReplayEvidence(evidence)).toThrow(
			/observability\.providerConfig must mirror replay\.providerConfig/s,
		);
	});

	it("imports without inheriting smoke-runner sandbox mode exits", () => {
		const result = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				"import './scripts/verify-published-replay-evidence.js';",
			],
			{
				cwd: process.cwd(),
				encoding: "utf8",
				env: {
					...process.env,
					MAESTRO_PUBLISHED_REPLAY_SANDBOX_MODE: "definitely-not-valid",
				},
			},
		);

		expect(result.status).toBe(0);
		expect(result.stderr).not.toContain(
			"Invalid MAESTRO_PUBLISHED_REPLAY_SANDBOX_MODE",
		);
	});

	it("validates both npm and Bun evidence artifacts as required release outputs", () => {
		withTempDir((dir) => {
			for (const installer of ["npm", "bun"]) {
				writeFileSync(
					join(dir, `${installer}-published-replay-evidence.json`),
					`${JSON.stringify(makeEvidence(installer as "npm" | "bun"), null, 2)}\n`,
				);
			}

			expect(
				validatePublishedReplayEvidenceSet({ evidenceDir: dir }).map(
					(summary) => summary.label,
				),
			).toEqual([
				"npm published replay evidence",
				"bun published replay evidence",
			]);
		});
	});

	it("fails when a Bun evidence file contains npm install evidence", () => {
		withTempDir((dir) => {
			writeFileSync(
				join(dir, "npm-published-replay-evidence.json"),
				`${JSON.stringify(makeEvidence("npm"), null, 2)}\n`,
			);
			writeFileSync(
				join(dir, "bun-published-replay-evidence.json"),
				`${JSON.stringify(makeEvidence("npm"), null, 2)}\n`,
			);

			expect(() =>
				validatePublishedReplayEvidenceSet({ evidenceDir: dir }),
			).toThrow(/installer must be bun.*package\.installMetadata\.label/s);
		});
	});

	it("honors installer expectations for explicit evidence files", () => {
		withTempDir((dir) => {
			const evidencePath = join(dir, "evidence.json");
			writeFileSync(
				evidencePath,
				`${JSON.stringify(makeEvidence("npm"), null, 2)}\n`,
			);

			expect(() =>
				validatePublishedReplayEvidenceSet({
					evidenceFiles: [evidencePath],
					installers: ["bun"],
				}),
			).toThrow(/installer must be bun.*package\.installMetadata\.label/s);
		});
	});

	it("fails when required Bun evidence is missing", () => {
		withTempDir((dir) => {
			writeFileSync(
				join(dir, "npm-published-replay-evidence.json"),
				`${JSON.stringify(makeEvidence(), null, 2)}\n`,
			);

			expect(() =>
				validatePublishedReplayEvidenceSet({ evidenceDir: dir }),
			).toThrow("Missing published replay evidence");
		});
	});

	it("fails when the release gate reports an unsatisfied published replay", () => {
		const evidence = makeEvidence();
		evidence.releaseGate.satisfied = false;
		evidence.releaseGate.failedChecks = ["toolEvidence"];
		evidence.releaseGate.checks.toolEvidence = false;

		expect(() => validatePublishedReplayEvidence(evidence)).toThrow(
			"toolEvidence",
		);
	});
});
