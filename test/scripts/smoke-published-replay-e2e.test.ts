import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildPublishedReplayEvidence,
	filterPublishedReplayEvidenceRefs,
	registryInstallPlanForInstaller,
	resolvePublishedReplayEvidencePath,
} from "../../scripts/smoke-published-replay-e2e.js";

const rootPackageName = ["@evalops", "maestro"].join("/");

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
		searchTool: {
			name: "search",
			callId: "call-search-package-manifest",
			inputPath: "package.json",
			resultStatus: "success",
		},
		artifactTool: {
			name: "write",
			callId: "call-write-published-artifact",
			inputPath: "published-replay-artifact.json",
			resultStatus: "success",
		},
		final: {
			status: "ok",
			containsExpectedText: true,
		},
		session: {
			sessionId: `session-${mode}`,
			jsonlFileCount: 1,
			bytes: 128,
			sha256: `sha256-${mode}`,
			containsFinalText: true,
			containsToolCallId: true,
			containsSearchToolCallId: true,
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
					toolName: "search",
					toolCallId: "call-search-package-manifest",
					evidenceRefs: [
						"tool-call:call-search-package-manifest",
						`tool-execution:tool-exec-search-${mode}`,
					],
					completionGate: "maestro_agent_runtime_ledger_recorded",
				},
				{
					toolName: "write",
					toolCallId: "call-write-published-artifact",
					evidenceRefs: [
						"tool-call:call-write-published-artifact",
						`tool-execution:tool-exec-write-${mode}`,
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

function makeReplayModeWithSharedWriteRefs(mode: "text" | "json" | "rpc") {
	const replayMode = makeReplayMode(mode);
	const writeItem = replayMode.agentRuntimeLedger.toolWorkItems.find(
		(item) => item.toolName === "write",
	);
	if (!writeItem) {
		throw new Error("Expected write tool work item in replay fixture");
	}
	writeItem.evidenceRefs = [
		"tool-call:call-write-published-artifact",
		"tool-execution:tool-exec-write-shared",
		"approval-request:call-write-published-artifact",
		"artifact:file:published-replay-artifact.json",
	];
	return replayMode;
}

function makeAgentRuntimeLifecycle() {
	return {
		schemaVersion: "evalops.maestro.agent-runtime-lifecycle.v1",
		sessionId: "published-lifecycle-fixture",
		replayDeterministic: true,
		counts: {
			entries: 8,
			promotionOperations: 18,
			waits: 2,
			approvalWaits: 1,
			toolRetryWaits: 1,
			terminalOperations: 1,
		},
		operations: {
			handleTrigger: 1,
			recordRunStep: 8,
			recordRunWorkItem: 8,
			waitRun: 2,
			terminal: 1,
			completeRun: 1,
			failRun: 0,
		},
		waits: [
			{
				pendingRequestId: "pending-lifecycle-approval",
				pendingRequestKind: "approval",
				waitType: "AGENT_RUN_WAIT_TYPE_APPROVAL",
				approvalRequestId: "approval-lifecycle-search",
				toolExecutionId: "tool-exec-lifecycle-search",
				evidenceRefs: [
					"pending-request:pending-lifecycle-approval",
					"approval-request:approval-lifecycle-search",
					"tool-execution:tool-exec-lifecycle-search",
				],
			},
			{
				pendingRequestId: "pending-lifecycle-retry",
				pendingRequestKind: "tool_retry",
				waitType: "AGENT_RUN_WAIT_TYPE_APPROVAL",
				approvalRequestId: "approval-lifecycle-retry",
				toolExecutionId: "tool-exec-lifecycle-search",
				evidenceRefs: [
					"pending-request:pending-lifecycle-retry",
					"approval-request:approval-lifecycle-retry",
					"tool-execution:tool-exec-lifecycle-search",
				],
			},
		],
		outcomes: {
			terminalStates: { succeeded: 1 },
			terminalEventTypes: ["message.assistant"],
		},
		durability: {
			reconstructable: true,
			sessionFilePresent: true,
			contextManifestPresent: true,
			replayDeterministic: true,
			promotionIdempotencyKey:
				"maestro-local-ledger:published-lifecycle-fixture:published-lifecycle-fixture",
			pendingRequests: 2,
		},
	};
}

describe("resolvePublishedReplayEvidencePath", () => {
	it("uses the requested package manager for standalone registry installs", () => {
		expect(
			registryInstallPlanForInstaller({
				installer: "npm",
				packageSpec: `${rootPackageName}@9.9.9`,
			}),
		).toMatchObject({
			installer: "npm",
			command: process.platform === "win32" ? "npm.cmd" : "npm",
			initArgs: ["init", "-y"],
			installArgs: ["install", `${rootPackageName}@9.9.9`],
			tempPrefix: "maestro-published-replay-install-",
		});
		expect(
			registryInstallPlanForInstaller({
				installer: "bun",
				packageSpec: `${rootPackageName}@9.9.9`,
			}),
		).toMatchObject({
			installer: "bun",
			command: process.platform === "win32" ? "bun.exe" : "bun",
			initArgs: ["init", "-y"],
			installArgs: ["add", `${rootPackageName}@9.9.9`],
			tempPrefix: "maestro-bun-published-replay-install-",
		});
	});

	it("rejects unsupported standalone registry installers", () => {
		expect(() =>
			registryInstallPlanForInstaller({
				installer: "pnpm",
				packageSpec: `${rootPackageName}@9.9.9`,
			}),
		).toThrow(/Unsupported published replay installer "pnpm"/);
	});

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
				agentRuntimeLifecycle: makeAgentRuntimeLifecycle(),
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

	it("preserves artifact refs for published replay observability", () => {
		expect(
			filterPublishedReplayEvidenceRefs([
				"tool-call:call-read-package-json",
				"tool-execution:tool-exec-1",
				"approval-request:approval-1",
				"artifact:manifest-1",
				"timeline-item:item-1",
				"",
			]),
		).toEqual([
			"tool-call:call-read-package-json",
			"tool-execution:tool-exec-1",
			"approval-request:approval-1",
			"artifact:manifest-1",
		]);
	});

	it("counts shared approval and artifact refs by replay mode", () => {
		const evidence = buildPublishedReplayEvidence({
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
				makeReplayModeWithSharedWriteRefs("text"),
				makeReplayModeWithSharedWriteRefs("json"),
				makeReplayModeWithSharedWriteRefs("rpc"),
			],
			agentRuntimeLifecycle: makeAgentRuntimeLifecycle(),
		});

		expect(evidence.observability.approvals).toMatchObject({
			count: 3,
			modes: ["text", "json", "rpc"],
			evidenceRefs: ["approval-request:call-write-published-artifact"],
		});
		expect(evidence.observability.artifacts).toMatchObject({
			count: 3,
			modes: ["text", "json", "rpc"],
			evidenceRefs: ["artifact:file:published-replay-artifact.json"],
		});
	});

	it("summarizes queryable release-gate evidence across install, replay, and ledger surfaces", () => {
		const evidence = buildPublishedReplayEvidence({
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
				makeReplayMode("text"),
				makeReplayMode("json"),
				makeReplayMode("rpc"),
			],
			agentRuntimeLifecycle: makeAgentRuntimeLifecycle(),
		});

		expect(evidence.releaseGate).toMatchObject({
			releaseBlocking: true,
			satisfied: true,
			failedChecks: [],
			checks: {
				installablePackageMetadata: true,
				noForbiddenWorkspaceReferences: true,
				noWorkspaceProtocolReferences: true,
				providerConfig: true,
				requiredReplayModes: true,
				transcriptEvidence: true,
				sessionEvidence: true,
				toolEvidence: true,
				toolExecutionEvidence: true,
				searchRipgrepEvidence: true,
				approvalTraceEvidence: true,
				errorTraceEvidence: true,
				artifactTraceEvidence: true,
				queryableObservabilityIndex: true,
				agentRuntimeLedger: true,
				agentRuntimeLifecycle: true,
				finalStatus: true,
			},
		});
		expect(evidence.observability).toMatchObject({
			install: {
				installable: true,
				forbiddenReferences: [],
				workspaceProtocolReferences: [],
			},
			providerConfig: {
				provider: "scripted-replay",
				model: "maestro-replay-v1",
				deterministic: true,
				externalCredentialsRequired: false,
				toolAllowlist: ["read", "search", "write"],
				approvalMode: "auto",
			},
			transcript: {
				modes: ["text", "json", "rpc"],
				toolCallIds: [
					"call-read-package-json",
					"call-search-package-manifest",
					"call-write-published-artifact",
				],
				finalStatus: {
					ok: 3,
				},
			},
			sessions: {
				modes: ["text", "json", "rpc"],
				jsonlFileCount: 3,
				bytes: 384,
			},
			tools: {
				names: ["read", "search", "write"],
				callIds: [
					"call-read-package-json",
					"call-search-package-manifest",
					"call-write-published-artifact",
				],
				resultStatus: {
					success: 9,
				},
				toolExecutionRefs: [
					"tool-execution:tool-exec-text",
					"tool-execution:tool-exec-json",
					"tool-execution:tool-exec-rpc",
					"tool-execution:tool-exec-search-text",
					"tool-execution:tool-exec-search-json",
					"tool-execution:tool-exec-search-rpc",
					"tool-execution:tool-exec-write-text",
					"tool-execution:tool-exec-write-json",
					"tool-execution:tool-exec-write-rpc",
				],
				toolExecutionRefsByCallId: {
					"call-read-package-json": [
						"tool-execution:tool-exec-text",
						"tool-execution:tool-exec-json",
						"tool-execution:tool-exec-rpc",
					],
					"call-search-package-manifest": [
						"tool-execution:tool-exec-search-text",
						"tool-execution:tool-exec-search-json",
						"tool-execution:tool-exec-search-rpc",
					],
					"call-write-published-artifact": [
						"tool-execution:tool-exec-write-text",
						"tool-execution:tool-exec-write-json",
						"tool-execution:tool-exec-write-rpc",
					],
				},
				toolExecutionModesByCallId: {
					"call-read-package-json": ["text", "json", "rpc"],
					"call-search-package-manifest": ["text", "json", "rpc"],
					"call-write-published-artifact": ["text", "json", "rpc"],
				},
				completionGates: ["maestro_agent_runtime_ledger_recorded"],
			},
			search: {
				engine: "ripgrep",
				toolName: "search",
				callId: "call-search-package-manifest",
				inputPath: "package.json",
				modes: ["text", "json", "rpc"],
			},
			agentRuntimeLifecycle: {
				schemaVersion: "evalops.maestro.agent-runtime-lifecycle.v1",
				waitKinds: ["approval", "tool_retry"],
				counts: {
					waits: 2,
					approvalWaits: 1,
					toolRetryWaits: 1,
					terminalOperations: 1,
				},
				operations: {
					waitRun: 2,
					completeRun: 1,
				},
			},
			approvals: {
				count: 3,
				modes: ["text", "json", "rpc"],
			},
			errors: {
				queryable: true,
				expectedCount: 0,
				count: 0,
				modes: [],
				byStatus: {
					ok: 3,
				},
			},
			artifacts: {
				count: 3,
				modes: ["text", "json", "rpc"],
			},
			finalStatus: {
				allOk: true,
				byStatus: {
					ok: 3,
				},
			},
			agentRuntimeLedger: {
				modes: ["text", "json", "rpc"],
				replayDeterministicModes: ["text", "json", "rpc"],
				durabilityModes: ["text", "json", "rpc"],
				counts: {
					entries: 12,
					promotionOperations: 18,
					byKind: {
						run: 3,
						tool_call: 3,
						tool_result: 3,
						runtime: 3,
					},
					byState: {
						running: 3,
						succeeded: 9,
					},
				},
				operations: {
					handleTrigger: 3,
					recordRunStep: 3,
					recordRunWorkItem: 3,
					terminal: 3,
				},
			},
		});
		expect(evidence.observability.queryIndex).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					key: "install",
					traceType: "install",
					queryable: true,
					query: expect.objectContaining({
						schemaVersion: "evalops.maestro.release-observability-query.v1",
						subjects: ["maestro.events.install_check.completed"],
						platformConsumers: ["release.maestro-install-smoke"],
						filterFields: ["packageSpec", "installer", "installable"],
					}),
					status: "ok",
				}),
				expect.objectContaining({
					key: "sessions",
					traceType: "session",
					queryable: true,
					status: "ok",
					modes: ["text", "json", "rpc"],
				}),
				expect.objectContaining({
					key: "tools",
					traceType: "tool",
					queryable: true,
					query: expect.objectContaining({
						subjects: [
							"maestro.events.tool_call.attempted",
							"maestro.events.tool_call.completed",
							"maestro.events.tool_call.failed",
						],
						filterFields: ["toolCallId", "toolName", "mode", "toolExecutionId"],
					}),
					status: "ok",
					modes: ["text", "json", "rpc"],
				}),
				expect.objectContaining({
					key: "search",
					traceType: "search",
					queryable: true,
					status: "ok",
					modes: ["text", "json", "rpc"],
				}),
				expect.objectContaining({
					key: "approvals",
					traceType: "approval",
					queryable: true,
					status: "ok",
					modes: ["text", "json", "rpc"],
				}),
				expect.objectContaining({
					key: "agentRuntimeLifecycle",
					traceType: "agent-runtime-lifecycle",
					queryable: true,
					query: expect.objectContaining({
						platformRecords: [
							"AgentRuntimeRun",
							"AgentRuntimeRunStep",
							"ToolExecution",
						],
						filterFields: ["sessionId", "pendingRequestId", "toolExecutionId"],
					}),
					status: "ok",
				}),
				expect.objectContaining({
					key: "errors",
					traceType: "error",
					queryable: true,
					status: "ok",
					modes: [],
				}),
				expect.objectContaining({
					key: "artifacts",
					traceType: "artifact",
					queryable: true,
					status: "ok",
					modes: ["text", "json", "rpc"],
				}),
				expect.objectContaining({
					key: "finalStatus",
					traceType: "final-status",
					queryable: true,
					status: "ok",
					modes: ["text", "json", "rpc"],
				}),
			]),
		);
		expect(evidence.replay.providerConfig).toMatchObject({
			provider: "scripted-replay",
			model: "maestro-replay-v1",
			deterministic: true,
			externalCredentialsRequired: false,
			toolAllowlist: ["read", "search", "write"],
			approvalMode: "auto",
		});
		expect(evidence.transcript.schemaVersion).toBe(
			"evalops.maestro.published-replay-transcript.v1",
		);
		const textTranscript = evidence.transcript.modes.find(
			(mode) => mode.mode === "text",
		);
		expect(textTranscript).toMatchObject({
			mode: "text",
			promptSha256: expect.any(String),
			final: {
				status: "ok",
				containsExpectedText: true,
			},
		});
		expect(textTranscript?.toolCalls).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "call-read-package-json",
					name: "read",
					inputPath: "package.json",
					resultStatus: "success",
				}),
				expect.objectContaining({
					id: "call-search-package-manifest",
					name: "search",
					inputPath: "package.json",
					resultStatus: "success",
				}),
				expect.objectContaining({
					id: "call-write-published-artifact",
					name: "write",
					inputPath: "published-replay-artifact.json",
					resultStatus: "success",
				}),
			]),
		);
	});

	it("does not satisfy the lifecycle gate without terminal outcome records", () => {
		const agentRuntimeLifecycle = makeAgentRuntimeLifecycle();
		agentRuntimeLifecycle.outcomes = {
			terminalStates: {},
			terminalEventTypes: [],
		};

		const evidence = buildPublishedReplayEvidence({
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
				makeReplayMode("text"),
				makeReplayMode("json"),
				makeReplayMode("rpc"),
			],
			agentRuntimeLifecycle,
		});

		expect(evidence.releaseGate.satisfied).toBe(false);
		expect(evidence.releaseGate.failedChecks).toContain(
			"agentRuntimeLifecycle",
		);
		expect(evidence.releaseGate.checks.agentRuntimeLifecycle).toBe(false);
		expect(
			evidence.observability.queryIndex.find(
				(entry) => entry.key === "agentRuntimeLifecycle",
			),
		).toMatchObject({
			status: "failed",
		});
	});

	it("does not satisfy the lifecycle gate when wait refs mismatch pending ids", () => {
		const agentRuntimeLifecycle = makeAgentRuntimeLifecycle();
		agentRuntimeLifecycle.waits[0].evidenceRefs = [
			"pending-request:pending-lifecycle-other",
			"approval-request:approval-lifecycle-search",
			"tool-execution:tool-exec-lifecycle-search",
		];

		const evidence = buildPublishedReplayEvidence({
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
				makeReplayMode("text"),
				makeReplayMode("json"),
				makeReplayMode("rpc"),
			],
			agentRuntimeLifecycle,
		});

		expect(evidence.releaseGate.satisfied).toBe(false);
		expect(evidence.releaseGate.failedChecks).toContain(
			"agentRuntimeLifecycle",
		);
		expect(evidence.releaseGate.checks.agentRuntimeLifecycle).toBe(false);
	});

	it("fails the release gate when published replay lacks search ripgrep evidence", () => {
		const withoutSearchEvidence = (mode: "text" | "json" | "rpc") => {
			const replayMode = makeReplayMode(mode);
			delete (replayMode as { searchTool?: unknown }).searchTool;
			replayMode.session.containsSearchToolCallId = false;
			replayMode.agentRuntimeLedger.toolWorkItems =
				replayMode.agentRuntimeLedger.toolWorkItems.filter(
					(item) => item.toolName !== "search",
				);
			return replayMode;
		};

		const evidence = buildPublishedReplayEvidence({
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
				withoutSearchEvidence("text"),
				withoutSearchEvidence("json"),
				withoutSearchEvidence("rpc"),
			],
		});

		expect(evidence.releaseGate.satisfied).toBe(false);
		expect(evidence.releaseGate.failedChecks).toContain(
			"searchRipgrepEvidence",
		);
	});

	it("fails the release gate when a replayed tool lacks ToolExecution evidence", () => {
		const withoutWriteToolExecution = (mode: "text" | "json" | "rpc") => {
			const replayMode = makeReplayMode(mode);
			const writeItem = replayMode.agentRuntimeLedger.toolWorkItems.find(
				(item) => item.toolName === "write",
			);
			if (!writeItem) {
				throw new Error("Expected write tool work item in replay fixture");
			}
			writeItem.evidenceRefs = writeItem.evidenceRefs.filter(
				(ref) => !ref.startsWith("tool-execution:"),
			);
			return replayMode;
		};

		const evidence = buildPublishedReplayEvidence({
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
				withoutWriteToolExecution("text"),
				withoutWriteToolExecution("json"),
				withoutWriteToolExecution("rpc"),
			],
		});

		expect(evidence.releaseGate.satisfied).toBe(false);
		expect(evidence.releaseGate.failedChecks).toContain(
			"toolExecutionEvidence",
		);
		const toolIndex = evidence.observability.queryIndex.find(
			(entry) => entry.traceType === "tool",
		);
		expect(toolIndex?.status).toBe("failed");
	});
});
