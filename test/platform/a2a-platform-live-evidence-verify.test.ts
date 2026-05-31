import {
	createHash,
	createPublicKey,
	generateKeyPairSync,
	sign as signBytes,
} from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyPlatformA2ALiveEvidenceFile } from "../../scripts/verify-platform-a2a-live-evidence.js";
import { getPackageName } from "../../src/package-metadata.js";

const joinParts = (...parts: string[]) => parts.join("");
const packageName = getPackageName();

function evidence(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		protocolVersion: "evalops.maestro.platform-a2a-live-smoke.v1",
		eventType: "platform_a2a_delegation_live_smoke",
		live: true,
		workspaceId: "ws_1",
		organizationId: "org_1",
		platformEndpoint: "https://platform.test",
		maestro: {
			gitSha: "1234567890abcdef1234567890abcdef12345678",
			cliPackage: packageName,
		},
		github: {
			repository: "evalops/maestro-internal",
			runId: "26252628231",
			runUrl:
				"https://github.com/evalops/maestro-internal/actions/runs/26252628231",
			sha: "1234567890abcdef1234567890abcdef12345678",
			pullRequestNumber: 2070,
			pullRequestUrl: "https://github.com/evalops/maestro-internal/pull/2070",
		},
		inputs: {
			fromAgentId: "maestro-origin",
			toAgentId: "maestro-target",
			skillId: "maestro.subagent.repo-explorer",
			promptHash: "a".repeat(64),
		},
		discovery: {
			target: {
				surface: "platform-agent-registry-peer-discovery",
				label: "target",
				sourceEvidencePresent: true,
				query: {
					organizationId: "org_1",
					workspaceId: "ws_1",
					skillId: "maestro.subagent.repo-explorer",
					limit: 100,
					requireA2ADispatch: true,
					eligibleForDelegation: true,
				},
				result: {
					schema: "agents.v1.discovery-evidence",
					decision: "matched",
					organizationId: "org_1",
					workspaceId: "ws_1",
					a2aSkillId: "maestro.subagent.repo-explorer",
					requireA2ADispatch: true,
					eligibleForDelegation: true,
					candidateCount: 2,
					matchedCount: 2,
					matchedAgentIds: ["maestro-origin", "maestro-target"],
					traceId: "trace-target",
					requestId: "request-target",
				},
			},
			origin: {
				surface: "platform-agent-registry-peer-discovery",
				label: "origin",
				sourceEvidencePresent: true,
				query: {
					organizationId: "org_1",
					workspaceId: "ws_1",
					limit: 100,
					requireA2ADispatch: true,
				},
				result: {
					schema: "agents.v1.discovery-evidence",
					decision: "matched",
					organizationId: "org_1",
					workspaceId: "ws_1",
					requireA2ADispatch: true,
					candidateCount: 1,
					matchedCount: 1,
					matchedAgentIds: ["maestro-origin"],
					traceId: "trace-origin",
					requestId: "request-origin",
				},
			},
		},
		peers: {
			origin: {
				agentId: "maestro-origin",
				endpointUrl: "https://origin.test/a2a",
			},
			target: {
				agentId: "maestro-target",
				endpointUrl: "https://target.test/a2a",
			},
		},
		delegation: {
			id: "delegation_1",
			a2aTaskId: "task_1",
			a2aMessageId: "message_1",
		},
		graph: {
			nodes: [{ delegationId: "delegation_1", a2aTaskId: "task_1" }],
			edges: [],
		},
		control: {
			mode: "A2A_DELEGATION_TASK_CONTROL_MODE_COLLECT",
			taskId: "task_1",
		},
		task: {
			id: "task_1",
			state: "TASK_STATE_COMPLETED",
			terminal: true,
			contextId: "context_1",
			messageIds: ["message_1"],
		},
		redaction: {
			rawTokensWithheld: true,
			rawPayloadsWithheld: true,
		},
		...overrides,
	};
}

function realtimeDeliveryEvidence(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		stream: {
			surface: "a2a-task-status-stream",
			sourceEvidencePresent: true,
			traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
			events: [
				{
					id: "stream_event_1",
					type: "task-status",
					taskId: "task_1",
					contextId: "context_1",
					messageId: "message_1",
					state: "TASK_STATE_WORKING",
					terminal: false,
					observedAt: "2026-05-30T08:00:00.000Z",
				},
				{
					id: "stream_event_2",
					type: "task-artifact",
					taskId: "task_1",
					contextId: "context_1",
					messageId: "message_1",
					state: "TASK_STATE_COMPLETED",
					terminal: true,
					artifactIds: ["artifact_1"],
					observedAt: "2026-05-30T08:00:01.000Z",
				},
			],
			terminalEventId: "stream_event_2",
			artifactIds: ["artifact_1"],
		},
		push: {
			surface: "a2a-task-push-notification",
			sourceEvidencePresent: true,
			callbackAuditId: "callback_audit_1",
			traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-cccccccccccccccc-01",
			acceptedCount: 2,
			rejectedCount: 1,
			invalidTokenRejected: true,
			terminalNotificationId: "push_notification_2",
			notifications: [
				{
					id: "push_notification_1",
					taskId: "task_1",
					contextId: "context_1",
					messageId: "message_1",
					state: "TASK_STATE_WORKING",
					accepted: true,
					terminal: false,
					observedAt: "2026-05-30T08:00:00.500Z",
				},
				{
					id: "push_notification_rejected_1",
					taskId: "task_1",
					contextId: "context_1",
					messageId: "message_1",
					state: "TASK_STATE_WORKING",
					accepted: false,
					terminal: false,
					errorClass: "unauthorized",
					observedAt: "2026-05-30T08:00:00.750Z",
				},
				{
					id: "push_notification_2",
					taskId: "task_1",
					contextId: "context_1",
					messageId: "message_1",
					state: "TASK_STATE_COMPLETED",
					accepted: true,
					terminal: true,
					observedAt: "2026-05-30T08:00:01.500Z",
				},
			],
		},
		trace: {
			rootTraceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			taskTraceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			streamTraceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			pushTraceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			correlated: true,
		},
		metrics: {
			surface: "platform-observability-delivery-metrics",
			sourceEvidencePresent: true,
			queryId: "delivery_metrics_query_1",
			workspaceId: "ws_1",
			windowStart: "2026-05-30T08:00:00.000Z",
			windowEnd: "2026-05-30T08:01:00.000Z",
			streamTerminalRate: 1,
			pushDeliveryLatencyMsP95: 750,
			callbackRejectionRate: 0.33,
			retryCount: 1,
			stuckDeliveryAlerts: 0,
		},
		...overrides,
	};
}

async function writeEvidenceBundle(
	dir: string,
	payload: Record<string, unknown>,
	sidecarOverride?: string,
	signature?: Record<string, unknown>,
): Promise<string> {
	const path = join(dir, "evidence.json");
	const bytes = `${JSON.stringify(payload, null, 2)}\n`;
	const digest = createHash("sha256").update(bytes).digest("hex");
	await writeFile(path, bytes);
	await writeFile(
		`${path}.sha256`,
		sidecarOverride ?? `${digest}  evidence.json\n`,
	);
	if (signature) {
		await writeFile(
			`${path}.sig.json`,
			`${JSON.stringify(signature, null, 2)}\n`,
		);
	}
	return path;
}

function signedEvidenceSidecar(
	bytes: string,
	privateKeyPem: string,
	publicKeyPem: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	const publicDer = createPublicKey(publicKeyPem).export({
		format: "der",
		type: "spki",
	});
	return {
		protocolVersion: "evalops.maestro.platform-a2a-live-evidence-signature.v1",
		algorithm: "ed25519",
		evidenceSha256: createHash("sha256").update(bytes).digest("hex"),
		signature: signBytes(null, Buffer.from(bytes), privateKeyPem).toString(
			"base64",
		),
		keyId: "platform-live-smoke-ci",
		publicKeyFingerprintSha256: createHash("sha256")
			.update(publicDer)
			.digest("hex"),
		signedAt: "2026-05-21T20:00:00.000Z",
		...overrides,
	};
}

describe("Platform A2A live evidence verifier", () => {
	it("accepts a hash-linked live evidence bundle", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(dir, evidence());
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path),
			).resolves.toMatchObject({
				path,
				protocolVersion: "evalops.maestro.platform-a2a-live-smoke.v1",
				gitSha: "1234567890abcdef1234567890abcdef12345678",
				delegationId: "delegation_1",
				a2aTaskId: "task_1",
				a2aMessageId: "message_1",
				contextId: "context_1",
				taskTerminal: true,
				githubRunId: "26252628231",
				githubPullRequestNumber: 2070,
				evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
				discovery: {
					targetSourceEvidencePresent: true,
					originSourceEvidencePresent: true,
					targetTraceId: "trace-target",
					originTraceId: "trace-origin",
				},
			});
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects digest mismatches", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence(),
				`${"0".repeat(64)}  evidence.json\n`,
			);
			await expect(verifyPlatformA2ALiveEvidenceFile(path)).rejects.toThrow(
				/digest mismatch/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects delegation and task id mismatches", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					task: {
						id: "task_2",
						state: "TASK_STATE_COMPLETED",
						terminal: true,
					},
				}),
			);
			await expect(verifyPlatformA2ALiveEvidenceFile(path)).rejects.toThrow(
				/delegation\.a2aTaskId task_1 does not match task\.id task_2/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects graph nodes that do not include the declared delegation", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					graph: {
						nodes: [{ delegationId: "delegation_other", a2aTaskId: "task_1" }],
						edges: [],
					},
				}),
			);
			await expect(verifyPlatformA2ALiveEvidenceFile(path)).rejects.toThrow(
				/graph does not include delegation\.id delegation_1/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("accepts strict durable A2A id evidence", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(dir, evidence());
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireDurableA2AIds: true,
				}),
			).resolves.toMatchObject({
				a2aTaskId: "task_1",
				a2aMessageId: "message_1",
				contextId: "context_1",
				taskTerminal: true,
			});
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects strict durable A2A evidence without the dispatch message id", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					delegation: {
						id: "delegation_1",
						a2aTaskId: "task_1",
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireDurableA2AIds: true,
				}),
			).rejects.toThrow(/requires delegation\.a2aMessageId/);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects strict durable A2A evidence when task messages omit the dispatch message id", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					task: {
						id: "task_1",
						state: "TASK_STATE_COMPLETED",
						terminal: true,
						contextId: "context_1",
						messageIds: ["message_other"],
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireDurableA2AIds: true,
				}),
			).rejects.toThrow(
				/task\.messageIds must include delegation\.a2aMessageId/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects strict durable A2A evidence before terminal task state", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					task: {
						id: "task_1",
						state: "TASK_STATE_WORKING",
						terminal: false,
						contextId: "context_1",
						messageIds: ["message_1"],
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireDurableA2AIds: true,
				}),
			).rejects.toThrow(/requires terminal task state/);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("accepts strict realtime delivery evidence", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					realtimeDelivery: realtimeDeliveryEvidence(),
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireRealtimeDeliveryEvidence: true,
				}),
			).resolves.toMatchObject({
				realtimeDelivery: {
					streamTerminalEventId: "stream_event_2",
					pushTerminalNotificationId: "push_notification_2",
					metricQueryId: "delivery_metrics_query_1",
					rootTraceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				},
			});
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("accepts optional realtime status and push records without message ids", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const delivery = realtimeDeliveryEvidence();
			const stream = delivery.stream as Record<string, unknown>;
			const push = delivery.push as Record<string, unknown>;
			const events = stream.events as Record<string, unknown>[];
			const notifications = push.notifications as Record<string, unknown>[];
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					realtimeDelivery: {
						...delivery,
						stream: {
							...stream,
							events: events.map(
								({ messageId: _messageId, ...event }) => event,
							),
						},
						push: {
							...push,
							notifications: notifications.map(
								({ messageId: _messageId, ...notification }) => notification,
							),
						},
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path),
			).resolves.toMatchObject({
				realtimeDelivery: {
					streamTerminalEventId: "stream_event_2",
					pushTerminalNotificationId: "push_notification_2",
				},
			});
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects realtime delivery without message ids when realtime delivery is required", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const delivery = realtimeDeliveryEvidence();
			const stream = delivery.stream as Record<string, unknown>;
			const push = delivery.push as Record<string, unknown>;
			const events = stream.events as Record<string, unknown>[];
			const notifications = push.notifications as Record<string, unknown>[];
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					realtimeDelivery: {
						...delivery,
						stream: {
							...stream,
							events: events.map(
								({ messageId: _messageId, ...event }) => event,
							),
						},
						push: {
							...push,
							notifications: notifications.map(
								({ messageId: _messageId, ...notification }) => notification,
							),
						},
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireRealtimeDeliveryEvidence: true,
				}),
			).rejects.toThrow(/requires messageId/);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("accepts realtime delivery records for later task message ids", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const delivery = realtimeDeliveryEvidence();
			const stream = delivery.stream as Record<string, unknown>;
			const push = delivery.push as Record<string, unknown>;
			const events = stream.events as Record<string, unknown>[];
			const notifications = push.notifications as Record<string, unknown>[];
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					task: {
						id: "task_1",
						state: "TASK_STATE_COMPLETED",
						terminal: true,
						contextId: "context_1",
						messageIds: ["message_1", "message_2"],
					},
					realtimeDelivery: {
						...delivery,
						stream: {
							...stream,
							events: events.map((event) => ({
								...event,
								messageId: "message_2",
							})),
						},
						push: {
							...push,
							notifications: notifications.map((notification) => ({
								...notification,
								messageId: "message_2",
							})),
						},
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireRealtimeDeliveryEvidence: true,
				}),
			).resolves.toMatchObject({
				realtimeDelivery: {
					streamTerminalEventId: "stream_event_2",
					pushTerminalNotificationId: "push_notification_2",
				},
			});
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects realtime delivery records for unknown task message ids", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const delivery = realtimeDeliveryEvidence();
			const stream = delivery.stream as Record<string, unknown>;
			const events = stream.events as Record<string, unknown>[];
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					realtimeDelivery: {
						...delivery,
						stream: {
							...stream,
							events: events.map((event, index) =>
								index === 1 ? { ...event, messageId: "message_2" } : event,
							),
						},
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireRealtimeDeliveryEvidence: true,
				}),
			).rejects.toThrow(
				/messageId message_2 is not present in task\.messageIds/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("accepts terminal realtime status events without artifact ids", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const delivery = realtimeDeliveryEvidence();
			const stream = delivery.stream as Record<string, unknown>;
			const events = stream.events as Record<string, unknown>[];
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					realtimeDelivery: {
						...delivery,
						stream: {
							...stream,
							events: events.map((event, index) => {
								if (index !== 1) {
									return event;
								}
								const { artifactIds: _artifactIds, ...terminalStatusEvent } =
									event;
								return {
									...terminalStatusEvent,
									type: "statusUpdate",
								};
							}),
						},
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireRealtimeDeliveryEvidence: true,
				}),
			).resolves.toMatchObject({
				realtimeDelivery: {
					streamTerminalEventId: "stream_event_2",
					pushTerminalNotificationId: "push_notification_2",
				},
			});
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("accepts terminal realtime artifact events without state", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const delivery = realtimeDeliveryEvidence();
			const stream = delivery.stream as Record<string, unknown>;
			const events = stream.events as Record<string, unknown>[];
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					realtimeDelivery: {
						...delivery,
						stream: {
							...stream,
							events: events.map((event, index) => {
								if (index !== 1) {
									return event;
								}
								const { state: _state, ...terminalArtifactEvent } = event;
								return {
									...terminalArtifactEvent,
									type: "artifactUpdate",
								};
							}),
						},
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireRealtimeDeliveryEvidence: true,
				}),
			).resolves.toMatchObject({
				realtimeDelivery: {
					streamTerminalEventId: "stream_event_2",
					pushTerminalNotificationId: "push_notification_2",
				},
			});
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects unknown realtime stream event types", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const delivery = realtimeDeliveryEvidence();
			const stream = delivery.stream as Record<string, unknown>;
			const events = stream.events as Record<string, unknown>[];
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					realtimeDelivery: {
						...delivery,
						stream: {
							...stream,
							events: events.map((event, index) =>
								index === 0 ? { ...event, type: "noop" } : event,
							),
						},
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireRealtimeDeliveryEvidence: true,
				}),
			).rejects.toThrow(/unsupported realtime stream event type noop/);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("accepts task and message realtime stream event types", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const delivery = realtimeDeliveryEvidence();
			const stream = delivery.stream as Record<string, unknown>;
			const events = stream.events as Record<string, unknown>[];
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					realtimeDelivery: {
						...delivery,
						stream: {
							...stream,
							events: [
								{
									id: "stream_event_task",
									type: "task",
									taskId: "task_1",
									contextId: "context_1",
									messageId: "message_1",
									terminal: false,
									observedAt: "2026-05-30T08:00:00.001Z",
								},
								{
									id: "stream_event_message",
									type: "message",
									taskId: "task_1",
									contextId: "context_1",
									messageId: "message_1",
									terminal: false,
									observedAt: "2026-05-30T08:00:00.002Z",
								},
								...events,
							],
						},
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireRealtimeDeliveryEvidence: true,
				}),
			).resolves.toMatchObject({
				realtimeDelivery: {
					streamTerminalEventId: "stream_event_2",
				},
			});
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects missing realtime delivery evidence when required", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(dir, evidence());
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireRealtimeDeliveryEvidence: true,
				}),
			).rejects.toThrow(/requires realtime delivery evidence/);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects realtime stream events for a different task", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const delivery = realtimeDeliveryEvidence();
			const stream = delivery.stream as Record<string, unknown>;
			const events = stream.events as Record<string, unknown>[];
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					realtimeDelivery: {
						...delivery,
						stream: {
							...stream,
							events: events.map((event, index) =>
								index === 1 ? { ...event, taskId: "task_other" } : event,
							),
						},
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireRealtimeDeliveryEvidence: true,
				}),
			).rejects.toThrow(/realtime stream event stream_event_2 taskId/);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects realtime stream events after the terminal event", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const delivery = realtimeDeliveryEvidence();
			const stream = delivery.stream as Record<string, unknown>;
			const events = stream.events as Record<string, unknown>[];
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					realtimeDelivery: {
						...delivery,
						stream: {
							...stream,
							events: [events[1], events[0]],
						},
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireRealtimeDeliveryEvidence: true,
				}),
			).rejects.toThrow(/after terminalEventId stream_event_2/);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects terminal realtime status events without state", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const delivery = realtimeDeliveryEvidence();
			const stream = delivery.stream as Record<string, unknown>;
			const events = stream.events as Record<string, unknown>[];
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					realtimeDelivery: {
						...delivery,
						stream: {
							...stream,
							events: events.map((event, index) => {
								if (index !== 1) {
									return event;
								}
								const {
									artifactIds: _artifactIds,
									state: _state,
									...terminalStatusEvent
								} = event;
								return {
									...terminalStatusEvent,
									type: "statusUpdate",
								};
							}),
						},
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireRealtimeDeliveryEvidence: true,
				}),
			).rejects.toThrow(/realtime stream event stream_event_2 state missing/);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects terminal realtime artifact events without artifact ids", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const delivery = realtimeDeliveryEvidence();
			const stream = delivery.stream as Record<string, unknown>;
			const events = stream.events as Record<string, unknown>[];
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					realtimeDelivery: {
						...delivery,
						stream: {
							...stream,
							events: events.map((event, index) => {
								if (index !== 1) {
									return event;
								}
								const { artifactIds: _artifactIds, ...terminalArtifactEvent } =
									event;
								return terminalArtifactEvent;
							}),
						},
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireRealtimeDeliveryEvidence: true,
				}),
			).rejects.toThrow(
				/realtime stream event stream_event_2 requires artifactIds/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects realtime stream evidence without a traceparent", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const delivery = realtimeDeliveryEvidence();
			const stream = delivery.stream as Record<string, unknown>;
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					realtimeDelivery: {
						...delivery,
						stream: {
							...stream,
							traceparent: undefined,
						},
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireRealtimeDeliveryEvidence: true,
				}),
			).rejects.toThrow(/traceparent/);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects realtime stream evidence with a zero traceparent span id", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const delivery = realtimeDeliveryEvidence();
			const stream = delivery.stream as Record<string, unknown>;
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					realtimeDelivery: {
						...delivery,
						stream: {
							...stream,
							traceparent:
								"00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-0000000000000000-01",
						},
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireRealtimeDeliveryEvidence: true,
				}),
			).rejects.toThrow(/traceparent/);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects realtime delivery trace evidence without child trace ids", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const delivery = realtimeDeliveryEvidence();
			const trace = delivery.trace as Record<string, unknown>;
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					realtimeDelivery: {
						...delivery,
						trace: {
							rootTraceId: trace.rootTraceId,
							correlated: true,
						},
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireRealtimeDeliveryEvidence: true,
				}),
			).rejects.toThrow(/taskTraceId/);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects realtime push evidence whose rejected count has no notification record", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const delivery = realtimeDeliveryEvidence();
			const push = delivery.push as Record<string, unknown>;
			const notifications = push.notifications as Record<string, unknown>[];
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					realtimeDelivery: {
						...delivery,
						push: {
							...push,
							notifications: notifications.filter(
								(notification) => notification.accepted !== false,
							),
						},
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireRealtimeDeliveryEvidence: true,
				}),
			).rejects.toThrow(/realtime push rejectedCount 1/);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects realtime push evidence without a traceparent", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const delivery = realtimeDeliveryEvidence();
			const push = delivery.push as Record<string, unknown>;
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					realtimeDelivery: {
						...delivery,
						push: {
							...push,
							traceparent: undefined,
						},
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireRealtimeDeliveryEvidence: true,
				}),
			).rejects.toThrow(/traceparent/);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects invalid-token push evidence without an auth rejected notification", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const delivery = realtimeDeliveryEvidence();
			const push = delivery.push as Record<string, unknown>;
			const notifications = push.notifications as Record<string, unknown>[];
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					realtimeDelivery: {
						...delivery,
						push: {
							...push,
							notifications: notifications.map((notification) =>
								notification.accepted === false
									? { ...notification, errorClass: "timeout" }
									: notification,
							),
						},
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireRealtimeDeliveryEvidence: true,
				}),
			).rejects.toThrow(/invalidTokenRejected/);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects realtime delivery metrics that start after observed deliveries", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const delivery = realtimeDeliveryEvidence();
			const metrics = delivery.metrics as Record<string, unknown>;
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					realtimeDelivery: {
						...delivery,
						metrics: {
							...metrics,
							windowStart: "2026-05-30T08:00:00.250Z",
						},
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireRealtimeDeliveryEvidence: true,
				}),
			).rejects.toThrow(/metrics window must include observed/);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects realtime delivery metrics that end before observed deliveries", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const delivery = realtimeDeliveryEvidence();
			const metrics = delivery.metrics as Record<string, unknown>;
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					realtimeDelivery: {
						...delivery,
						metrics: {
							...metrics,
							windowEnd: "2026-05-30T08:00:01.250Z",
						},
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireRealtimeDeliveryEvidence: true,
				}),
			).rejects.toThrow(/metrics window must include observed/);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects realtime delivery evidence without operator metrics", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const delivery = realtimeDeliveryEvidence({ metrics: undefined });
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					realtimeDelivery: delivery,
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireRealtimeDeliveryEvidence: true,
				}),
			).rejects.toThrow(/realtime delivery metrics/);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects control task ids that do not match the verified task", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					control: {
						mode: "A2A_DELEGATION_TASK_CONTROL_MODE_COLLECT",
						taskId: "task_other",
					},
				}),
			);
			await expect(verifyPlatformA2ALiveEvidenceFile(path)).rejects.toThrow(
				/control\.taskId task_other does not match task\.id task_1/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects delegation inputs that do not match declared peers", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					inputs: {
						fromAgentId: "maestro-other-origin",
						toAgentId: "maestro-target",
						promptHash: "a".repeat(64),
					},
				}),
			);
			await expect(verifyPlatformA2ALiveEvidenceFile(path)).rejects.toThrow(
				/inputs\.fromAgentId maestro-other-origin does not match peers\.origin\.agentId maestro-origin/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("dereferences GitHub run and PR evidence when required", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const paths: string[] = [];
			const path = await writeEvidenceBundle(dir, evidence());
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireDereferenceableGithub: true,
					githubApiClient: async (apiPath) => {
						paths.push(apiPath);
						if (
							apiPath ===
							"/repos/evalops/maestro-internal/actions/runs/26252628231"
						) {
							return { id: 26252628231 };
						}
						if (apiPath === "/repos/evalops/maestro-internal/pulls/2070") {
							return { number: 2070 };
						}
						throw new Error(`unexpected GitHub API path ${apiPath}`);
					},
				}),
			).resolves.toMatchObject({
				githubDereferenced: true,
				githubPullRequestNumber: 2070,
				githubRunId: "26252628231",
			});
			expect(paths).toEqual([
				"/repos/evalops/maestro-internal/actions/runs/26252628231",
				"/repos/evalops/maestro-internal/pulls/2070",
			]);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("dereferences GHES evidence through the evidence server API host", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		const originalFetch = globalThis.fetch;
		const urls: string[] = [];
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					github: {
						repository: "evalops/maestro-internal",
						serverUrl: "https://github.example.com",
						runId: "26252628231",
						runUrl:
							"https://github.example.com/evalops/maestro-internal/actions/runs/26252628231",
						sha: "1234567890abcdef1234567890abcdef12345678",
						pullRequestNumber: 2070,
						pullRequestUrl:
							"https://github.example.com/evalops/maestro-internal/pull/2070",
					},
				}),
			);
			globalThis.fetch = (async (input) => {
				const url = String(input);
				urls.push(url);
				if (url.endsWith("/actions/runs/26252628231")) {
					return new Response(JSON.stringify({ id: 26252628231 }), {
						headers: { "content-type": "application/json" },
						status: 200,
					});
				}
				if (url.endsWith("/pulls/2070")) {
					return new Response(JSON.stringify({ number: 2070 }), {
						headers: { "content-type": "application/json" },
						status: 200,
					});
				}
				return new Response(JSON.stringify({ message: "not found" }), {
					status: 404,
				});
			}) as typeof fetch;

			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireDereferenceableGithub: true,
				}),
			).resolves.toMatchObject({
				githubDereferenced: true,
				githubPullRequestNumber: 2070,
				githubRunId: "26252628231",
			});
			expect(urls).toEqual([
				"https://github.example.com/api/v3/repos/evalops/maestro-internal/actions/runs/26252628231",
				"https://github.example.com/api/v3/repos/evalops/maestro-internal/pulls/2070",
			]);
		} finally {
			globalThis.fetch = originalFetch;
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects non-HTTPS GitHub server URLs before dereferencing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		const paths: string[] = [];
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					github: {
						repository: "evalops/maestro-internal",
						serverUrl: "http://github.example.com",
						runId: "26252628231",
						runUrl:
							"http://github.example.com/evalops/maestro-internal/actions/runs/26252628231",
						sha: "1234567890abcdef1234567890abcdef12345678",
						pullRequestNumber: 2070,
						pullRequestUrl:
							"http://github.example.com/evalops/maestro-internal/pull/2070",
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireDereferenceableGithub: true,
					githubApiClient: async (apiPath) => {
						paths.push(apiPath);
						throw new Error("GitHub API client should not be called");
					},
				}),
			).rejects.toThrow(/server URL must use HTTPS/);
			expect(paths).toEqual([]);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects GitHub run URLs that do not match the run id", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					github: {
						repository: "evalops/maestro-internal",
						runId: "26252628231",
						runUrl:
							"https://github.com/evalops/maestro-internal/actions/runs/26252628232",
						sha: "1234567890abcdef1234567890abcdef12345678",
						pullRequestNumber: 2070,
						pullRequestUrl:
							"https://github.com/evalops/maestro-internal/pull/2070",
					},
				}),
			);
			await expect(verifyPlatformA2ALiveEvidenceFile(path)).rejects.toThrow(
				/run URL id 26252628232 does not match runId 26252628231/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("accepts invalid-token rejection evidence when required", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					negativeAuthProbe: {
						surface: "platform-agent-registry-peer-discovery",
						rejected: true,
						errorClass: "forbidden",
						observedAt: "2026-05-21T20:00:00.000Z",
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireNegativeAuthProbe: true,
				}),
			).resolves.toMatchObject({
				negativeAuthProbe: {
					surface: "platform-agent-registry-peer-discovery",
					rejected: true,
					errorClass: "forbidden",
				},
			});
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects missing invalid-token evidence when required", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(dir, evidence());
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireNegativeAuthProbe: true,
				}),
			).rejects.toThrow(/requires invalid-token rejection evidence/);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects invalid-token evidence that is not rejected", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					negativeAuthProbe: {
						surface: "platform-agent-registry-peer-discovery",
						rejected: false,
						errorClass: "forbidden",
						observedAt: "2026-05-21T20:00:00.000Z",
					},
				}),
			);
			await expect(verifyPlatformA2ALiveEvidenceFile(path)).rejects.toThrow(
				/not marked rejected/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("requires source Agent Registry discovery evidence when requested", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					discovery: {
						target: {
							...(evidence().discovery as Record<string, unknown>).target,
							sourceEvidencePresent: false,
						},
						origin: (evidence().discovery as Record<string, unknown>).origin,
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireDiscoveryEvidence: true,
				}),
			).rejects.toThrow(/requires source Agent Registry discovery evidence/);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects strict target discovery evidence that omits the requested skill filter", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const base = evidence();
			const discovery = base.discovery as Record<
				string,
				Record<string, unknown>
			>;
			const target = discovery.target as Record<string, unknown>;
			const query = target.query as Record<string, unknown>;
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					discovery: {
						...discovery,
						target: {
							...target,
							query: {
								...query,
								skillId: undefined,
							},
						},
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireDiscoveryEvidence: true,
				}),
			).rejects.toThrow(
				/discovery\.target\.query\.skillId missing does not match inputs\.skillId maestro\.subagent\.repo-explorer/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects strict target discovery evidence with the wrong registry skill result", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const base = evidence();
			const discovery = base.discovery as Record<
				string,
				Record<string, unknown>
			>;
			const target = discovery.target as Record<string, unknown>;
			const result = target.result as Record<string, unknown>;
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					discovery: {
						...discovery,
						target: {
							...target,
							result: {
								...result,
								a2aSkillId: "maestro.subagent.other",
							},
						},
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireDiscoveryEvidence: true,
				}),
			).rejects.toThrow(
				/discovery\.target\.result\.a2aSkillId maestro\.subagent\.other does not match inputs\.skillId maestro\.subagent\.repo-explorer/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects strict target discovery evidence that omits the registry skill result", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const base = evidence();
			const discovery = base.discovery as Record<
				string,
				Record<string, unknown>
			>;
			const target = discovery.target as Record<string, unknown>;
			const result = target.result as Record<string, unknown>;
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					discovery: {
						...discovery,
						target: {
							...target,
							result: {
								...result,
								a2aSkillId: undefined,
							},
						},
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireDiscoveryEvidence: true,
				}),
			).rejects.toThrow(
				/discovery\.target\.result\.a2aSkillId missing does not match inputs\.skillId maestro\.subagent\.repo-explorer/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("accepts strict target discovery evidence with an array capability result", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const base = evidence({
				inputs: {
					fromAgentId: "maestro-origin",
					toAgentId: "maestro-target",
					capability: "repo.read",
					promptHash: "a".repeat(64),
				},
			});
			const discovery = base.discovery as Record<
				string,
				Record<string, unknown>
			>;
			const target = discovery.target as Record<string, unknown>;
			const query = target.query as Record<string, unknown>;
			const result = target.result as Record<string, unknown>;
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					inputs: base.inputs,
					discovery: {
						...discovery,
						target: {
							...target,
							query: {
								...query,
								capability: "repo.read",
								skillId: undefined,
							},
							result: {
								...result,
								a2aSkillId: undefined,
								capability: undefined,
								capabilities: ["repo.read", "repo.write"],
							},
						},
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireDiscoveryEvidence: true,
				}),
			).resolves.toMatchObject({
				discovery: {
					targetSourceEvidencePresent: true,
				},
			});
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects strict target discovery evidence that omits source scope fields", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const base = evidence();
			const discovery = base.discovery as Record<
				string,
				Record<string, unknown>
			>;
			const target = discovery.target as Record<string, unknown>;
			const result = target.result as Record<string, unknown>;
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					discovery: {
						...discovery,
						target: {
							...target,
							result: {
								...result,
								workspaceId: undefined,
							},
						},
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireDiscoveryEvidence: true,
				}),
			).rejects.toThrow(
				/discovery\.target\.result\.workspaceId missing does not match workspaceId ws_1/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("accepts strict capability discovery evidence that uses capabilities array form", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const base = evidence();
			const discovery = base.discovery as Record<
				string,
				Record<string, unknown>
			>;
			const target = discovery.target as Record<string, unknown>;
			const query = target.query as Record<string, unknown>;
			const result = target.result as Record<string, unknown>;
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					inputs: {
						fromAgentId: "maestro-origin",
						toAgentId: "maestro-target",
						capability: "repo.explore",
						promptHash: "a".repeat(64),
					},
					discovery: {
						...discovery,
						target: {
							...target,
							query: {
								...query,
								skillId: undefined,
								capability: "repo.explore",
							},
							result: {
								...result,
								a2aSkillId: undefined,
								capability: undefined,
								capabilities: ["repo.explore"],
							},
						},
					},
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireDiscoveryEvidence: true,
				}),
			).resolves.toMatchObject({
				discovery: {
					targetSourceEvidencePresent: true,
					originSourceEvidencePresent: true,
				},
			});
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects discovery evidence whose matched count disagrees with matched ids", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const base = evidence();
			const discovery = base.discovery as Record<
				string,
				Record<string, unknown>
			>;
			const target = discovery.target as Record<string, unknown>;
			const result = target.result as Record<string, unknown>;
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					discovery: {
						...discovery,
						target: {
							...target,
							result: {
								...result,
								matchedCount: 0,
							},
						},
					},
				}),
			);
			await expect(verifyPlatformA2ALiveEvidenceFile(path)).rejects.toThrow(
				/discovery\.target\.result matchedCount 0 does not match matchedAgentIds length 2/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects discovery evidence that does not match the target agent", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const base = evidence();
			const discovery = base.discovery as Record<
				string,
				Record<string, unknown>
			>;
			const target = discovery.target as Record<string, unknown>;
			const result = target.result as Record<string, unknown>;
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					discovery: {
						...discovery,
						target: {
							...target,
							result: {
								...result,
								matchedCount: 1,
								matchedAgentIds: ["maestro-origin"],
							},
						},
					},
				}),
			);
			await expect(verifyPlatformA2ALiveEvidenceFile(path)).rejects.toThrow(
				/discovery\.target did not match target agent maestro-target/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects GitHub metadata that does not resolve when dereference is required", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(dir, evidence());
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					requireDereferenceableGithub: true,
					githubApiClient: async () => {
						throw new Error("HTTP 404 not found");
					},
				}),
			).rejects.toThrow(/HTTP 404 not found/);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("accepts a signed live evidence bundle when signature verification is required", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const { privateKey, publicKey } = generateKeyPairSync("ed25519");
			const privateKeyPem = privateKey.export({
				format: "pem",
				type: "pkcs8",
			}) as string;
			const publicKeyPem = publicKey.export({
				format: "pem",
				type: "spki",
			}) as string;
			const payload = evidence();
			const bytes = `${JSON.stringify(payload, null, 2)}\n`;
			const path = await writeEvidenceBundle(
				dir,
				payload,
				undefined,
				signedEvidenceSidecar(bytes, privateKeyPem, publicKeyPem),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					publicKeyPem,
					requireSignature: true,
				}),
			).resolves.toMatchObject({
				signature: {
					algorithm: "ed25519",
					keyId: "platform-live-smoke-ci",
					verified: true,
				},
			});
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects missing signatures when signature verification is required", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(dir, evidence());
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, { requireSignature: true }),
			).rejects.toThrow(/requires a detached signature sidecar/);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects tampered detached signatures", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const { privateKey, publicKey } = generateKeyPairSync("ed25519");
			const privateKeyPem = privateKey.export({
				format: "pem",
				type: "pkcs8",
			}) as string;
			const publicKeyPem = publicKey.export({
				format: "pem",
				type: "spki",
			}) as string;
			const payload = evidence();
			const bytes = `${JSON.stringify(payload, null, 2)}\n`;
			const path = await writeEvidenceBundle(
				dir,
				payload,
				undefined,
				signedEvidenceSidecar(bytes, privateKeyPem, publicKeyPem, {
					signature: Buffer.from("not the signed evidence").toString("base64"),
				}),
			);
			await expect(
				verifyPlatformA2ALiveEvidenceFile(path, {
					publicKeyPem,
					requireSignature: true,
				}),
			).rejects.toThrow(/detached signature is invalid/);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects production-looking evidence with synthetic git SHAs", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					maestro: {
						gitSha: joinParts(
							"9f3a",
							"20260520222033",
							"c0de",
							"5afe",
							"00000000000001",
						),
						cliPackage: packageName,
					},
				}),
			);
			await expect(verifyPlatformA2ALiveEvidenceFile(path)).rejects.toThrow(
				/synthetic/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects production-looking evidence with synthetic GitHub identifiers", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					github: {
						repository: "evalops/maestro-internal",
						runId: joinParts("gha-run-", "20260520T222033Z", "-local"),
						pullRequest: joinParts(
							"evalops/platform#",
							"prod-pr-lane-",
							"20260520T222033Z",
							"-local",
						),
						sha: "1234567890abcdef1234567890abcdef12345678",
					},
				}),
			);
			await expect(verifyPlatformA2ALiveEvidenceFile(path)).rejects.toThrow(
				/positive integer id|integer PR number/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("rejects local proof ids in live evidence", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-evidence-"));
		try {
			const path = await writeEvidenceBundle(
				dir,
				evidence({
					proof: {
						id: "platform-a2a-proof-local",
					},
				}),
			);
			await expect(verifyPlatformA2ALiveEvidenceFile(path)).rejects.toThrow(
				/local synthetic proof id/,
			);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});
});
