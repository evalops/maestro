import { createHash, createPublicKey, verify as verifyBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

type Env = Record<string, string | undefined>;
type GithubApiClient = (
	path: string,
	env: Env,
	serverUrl: string | undefined,
) => Promise<unknown>;

interface VerifiedGithubEvidence {
	repository?: string;
	serverUrl?: string;
	runId?: string;
	pullRequestNumber?: number;
	sha?: string;
}

interface PlatformA2ALiveEvidenceVerification {
	path: string;
	evidenceSha256: string;
	protocolVersion: string;
	gitSha: string;
	githubRunId?: string;
	githubPullRequestNumber?: number;
	githubDereferenced?: true;
	negativeAuthProbe?: {
		surface: "platform-agent-registry-peer-discovery";
		errorClass: "unauthorized" | "forbidden";
		rejected: true;
	};
	signature?: {
		algorithm: "ed25519";
		keyId?: string;
		publicKeyFingerprintSha256: string;
		signaturePath: string;
		verified: true;
	};
	delegationId: string;
	a2aTaskId: string;
	a2aMessageId?: string;
	contextId?: string;
	taskTerminal: boolean;
	discovery?: {
		targetSourceEvidencePresent: boolean;
		originSourceEvidencePresent: boolean;
		targetTraceId?: string;
		originTraceId?: string;
	};
	realtimeDelivery?: {
		streamTerminalEventId: string;
		pushTerminalNotificationId: string;
		metricQueryId: string;
		rootTraceId: string;
	};
}

export interface PlatformA2ALiveEvidenceVerificationOptions {
	requireSignature?: boolean;
	requireDereferenceableGithub?: boolean;
	requireNegativeAuthProbe?: boolean;
	requireDiscoveryEvidence?: boolean;
	requireDurableA2AIds?: boolean;
	requireRealtimeDeliveryEvidence?: boolean;
	publicKeyPem?: string;
	publicKeyPath?: string;
	env?: Env;
	githubApiClient?: GithubApiClient;
}

const PROTOCOL_VERSION = "evalops.maestro.platform-a2a-live-smoke.v1";
const SIGNATURE_PROTOCOL_VERSION =
	"evalops.maestro.platform-a2a-live-evidence-signature.v1";
const TERMINAL_TASK_STATES = new Set([
	"TASK_STATE_COMPLETED",
	"TASK_STATE_FAILED",
	"TASK_STATE_CANCELED",
	"TASK_STATE_CANCELLED",
	"TASK_STATE_REJECTED",
]);
const REALTIME_STREAM_EVENT_TYPES = new Set([
	"task",
	"message",
	"task-status",
	"task-artifact",
	"statusUpdate",
	"artifactUpdate",
]);

const VERIFICATION_KEY_ENV_VARS = [
	"MAESTRO_A2A_LIVE_EVIDENCE_VERIFY_PUBLIC_KEY",
	"MAESTRO_A2A_LIVE_EVIDENCE_PUBLIC_KEY",
] as const;

const VERIFICATION_KEY_FILE_ENV_VARS = [
	"MAESTRO_A2A_LIVE_EVIDENCE_VERIFY_PUBLIC_KEY_FILE",
	"MAESTRO_A2A_LIVE_EVIDENCE_PUBLIC_KEY_FILE",
] as const;

export async function verifyPlatformA2ALiveEvidenceFile(
	evidencePath: string,
	options: PlatformA2ALiveEvidenceVerificationOptions = {},
): Promise<PlatformA2ALiveEvidenceVerification> {
	const evidenceBytes = await readFile(evidencePath, "utf8");
	const sidecar = await readFile(`${evidencePath}.sha256`, "utf8");
	const expectedDigest = parseSidecarDigest(sidecar);
	const actualDigest = sha256Hex(evidenceBytes);
	if (actualDigest !== expectedDigest) {
		throw new Error(
			`Platform A2A evidence digest mismatch for ${evidencePath}: expected ${expectedDigest}, got ${actualDigest}`,
		);
	}
	const evidence = JSON.parse(evidenceBytes) as unknown;
	const record = requireRecord(evidence, "evidence");
	const signature = await verifyDetachedSignature(
		evidencePath,
		evidenceBytes,
		actualDigest,
		options,
	);
	const protocolVersion = requireString(record, "protocolVersion");
	if (protocolVersion !== PROTOCOL_VERSION) {
		throw new Error(
			`unexpected Platform A2A evidence protocol ${protocolVersion}`,
		);
	}
	if (record.live !== true) {
		throw new Error("Platform A2A evidence is not marked live");
	}
	const workspaceId = requireString(record, "workspaceId");
	const organizationId = requireString(record, "organizationId");
	const maestro = requireRecord(record.maestro, "maestro");
	const gitSha = requireString(maestro, "gitSha");
	assertRealishGitSha(gitSha);
	assertNoSyntheticProofId(record);
	const github = verifyGithubEvidence(record.github);
	const githubDereferenced = await verifyDereferenceableGithubEvidence(
		github,
		options,
	);
	const delegation = requireRecord(record.delegation, "delegation");
	const delegationId = requireString(delegation, "id");
	const a2aTaskId = requireString(delegation, "a2aTaskId");
	const a2aMessageId = optionalString(delegation, "a2aMessageId");
	const inputs = requireRecord(record.inputs, "inputs");
	const fromAgentId = requireString(inputs, "fromAgentId");
	const toAgentId = requireString(inputs, "toAgentId");
	const skillId = optionalString(inputs, "skillId");
	const capability = optionalString(inputs, "capability");
	const promptHash = optionalString(inputs, "promptHash");
	if (promptHash && !/^[a-f0-9]{64}$/u.test(promptHash)) {
		throw new Error(
			`Platform A2A evidence inputs.promptHash must be a SHA-256 hex digest, got ${promptHash}`,
		);
	}
	const peers = requireRecord(record.peers, "peers");
	const origin = requireRecord(peers.origin, "peers.origin");
	const target = requireRecord(peers.target, "peers.target");
	const originAgentId = requireString(origin, "agentId");
	const targetAgentId = requireString(target, "agentId");
	if (fromAgentId !== originAgentId) {
		throw new Error(
			`Platform A2A evidence inputs.fromAgentId ${fromAgentId} does not match peers.origin.agentId ${originAgentId}`,
		);
	}
	if (toAgentId !== targetAgentId) {
		throw new Error(
			`Platform A2A evidence inputs.toAgentId ${toAgentId} does not match peers.target.agentId ${targetAgentId}`,
		);
	}
	const discovery = verifyDiscoveryEvidence(record.discovery, {
		workspaceId,
		organizationId,
		fromAgentId,
		toAgentId,
		skillId,
		capability,
		requireDiscoveryEvidence: options.requireDiscoveryEvidence,
	});
	const graph = requireRecord(record.graph, "graph");
	const nodes = graph.nodes;
	if (!Array.isArray(nodes) || nodes.length < 1) {
		throw new Error("Platform A2A evidence graph has no nodes");
	}
	let graphDelegationNode: Record<string, unknown> | undefined;
	const graphIncludesDelegation = nodes.some((nodeValue, index) => {
		const node = requireRecord(nodeValue, `graph.nodes[${index}]`);
		if (optionalString(node, "delegationId") === delegationId) {
			graphDelegationNode = node;
			return true;
		}
		return false;
	});
	if (!graphIncludesDelegation) {
		throw new Error(
			`Platform A2A evidence graph does not include delegation.id ${delegationId}`,
		);
	}
	const control = requireRecord(record.control, "control");
	requireString(control, "mode");
	const task = requireRecord(record.task, "task");
	const taskId = requireString(task, "id");
	if (taskId !== a2aTaskId) {
		throw new Error(
			`Platform A2A evidence delegation.a2aTaskId ${a2aTaskId} does not match task.id ${taskId}`,
		);
	}
	const controlTaskId = requireString(control, "taskId");
	if (controlTaskId !== taskId) {
		throw new Error(
			`Platform A2A evidence control.taskId ${controlTaskId} does not match task.id ${taskId}`,
		);
	}
	const taskState = optionalString(task, "state");
	const taskTerminal = requireBoolean(task, "terminal", "task");
	if (taskTerminal && taskState && !TERMINAL_TASK_STATES.has(taskState)) {
		throw new Error(
			`Platform A2A evidence task.terminal is true but task.state ${taskState} is not terminal`,
		);
	}
	const contextId = optionalString(task, "contextId");
	const taskMessageIds = optionalStringArray(task, "messageIds");
	verifyDurableA2AIdEvidence({
		options,
		delegationId,
		a2aTaskId,
		a2aMessageId,
		control,
		graphDelegationNode,
		inputs,
		taskId,
		taskState,
		taskTerminal,
		contextId,
		taskMessageIds,
		record,
	});
	const negativeAuthProbe = verifyNegativeAuthProbe(
		record.negativeAuthProbe,
		options,
	);
	const realtimeDelivery = verifyRealtimeDeliveryEvidence(
		record.realtimeDelivery,
		{
			options,
			workspaceId,
			a2aTaskId,
			a2aMessageId,
			contextId,
			taskState,
			taskTerminal,
			taskMessageIds,
		},
	);
	return {
		path: evidencePath,
		evidenceSha256: actualDigest,
		protocolVersion,
		gitSha,
		githubRunId: github?.runId,
		githubPullRequestNumber: github?.pullRequestNumber,
		githubDereferenced,
		negativeAuthProbe,
		signature,
		delegationId,
		a2aTaskId,
		a2aMessageId,
		contextId,
		taskTerminal,
		discovery,
		realtimeDelivery,
	};
}

function verifyDurableA2AIdEvidence(input: {
	options: PlatformA2ALiveEvidenceVerificationOptions;
	delegationId: string;
	a2aTaskId: string;
	a2aMessageId?: string;
	control: Record<string, unknown>;
	graphDelegationNode?: Record<string, unknown>;
	inputs: Record<string, unknown>;
	taskId: string;
	taskState?: string;
	taskTerminal: boolean;
	contextId?: string;
	taskMessageIds: string[];
	record: Record<string, unknown>;
}): void {
	const graphTaskId = input.graphDelegationNode
		? optionalString(input.graphDelegationNode, "a2aTaskId")
		: undefined;
	if (graphTaskId && graphTaskId !== input.a2aTaskId) {
		throw new Error(
			`Platform A2A evidence graph delegation ${input.delegationId} a2aTaskId ${graphTaskId} does not match delegation.a2aTaskId ${input.a2aTaskId}`,
		);
	}
	const controlMode = requireString(input.control, "mode");
	if (!input.options.requireDurableA2AIds) {
		return;
	}
	if (!input.a2aMessageId) {
		throw new Error(
			"Platform A2A evidence requires delegation.a2aMessageId for durable A2A id verification",
		);
	}
	if (!input.contextId) {
		throw new Error(
			"Platform A2A evidence requires task.contextId for durable A2A id verification",
		);
	}
	if (!input.taskTerminal || !input.taskState) {
		throw new Error(
			"Platform A2A evidence requires terminal task state for durable A2A id verification",
		);
	}
	if (!TERMINAL_TASK_STATES.has(input.taskState)) {
		throw new Error(
			`Platform A2A evidence task.state ${input.taskState} is not terminal for durable A2A id verification`,
		);
	}
	if (!input.taskMessageIds.includes(input.a2aMessageId)) {
		throw new Error(
			`Platform A2A evidence task.messageIds must include delegation.a2aMessageId ${input.a2aMessageId}`,
		);
	}
	if (!graphTaskId) {
		throw new Error(
			`Platform A2A evidence graph delegation ${input.delegationId} must include a2aTaskId for durable A2A id verification`,
		);
	}
	if (controlMode !== "A2A_DELEGATION_TASK_CONTROL_MODE_COLLECT") {
		throw new Error(
			`Platform A2A evidence control.mode ${controlMode} is not collect mode for durable A2A id verification`,
		);
	}
	const promptHash = requireString(input.inputs, "promptHash");
	if (!/^[a-f0-9]{64}$/u.test(promptHash)) {
		throw new Error(
			`Platform A2A evidence inputs.promptHash must be a SHA-256 hex digest, got ${promptHash}`,
		);
	}
	const redaction = requireRecord(input.record.redaction, "redaction");
	requireBooleanTrue(redaction, "rawTokensWithheld", "redaction");
	requireBooleanTrue(redaction, "rawPayloadsWithheld", "redaction");
}

function verifyDiscoveryEvidence(
	value: unknown,
	expected: {
		workspaceId: string;
		organizationId: string;
		fromAgentId: string;
		toAgentId: string;
		skillId?: string;
		capability?: string;
		requireDiscoveryEvidence?: boolean;
	},
): PlatformA2ALiveEvidenceVerification["discovery"] {
	if (value === undefined || value === null) {
		if (expected.requireDiscoveryEvidence) {
			throw new Error("Platform A2A evidence requires discovery evidence");
		}
		return undefined;
	}
	const discovery = requireRecord(value, "discovery");
	const target = verifyDiscoverySection(
		discovery.target,
		"discovery.target",
		expected,
		{
			requireRequestedFilters: expected.requireDiscoveryEvidence,
			requireSourceScope: expected.requireDiscoveryEvidence,
		},
	);
	const origin = verifyDiscoverySection(
		discovery.origin,
		"discovery.origin",
		expected,
		{ requireSourceScope: expected.requireDiscoveryEvidence },
	);
	if (!target.matchedAgentIds.includes(expected.toAgentId)) {
		throw new Error(
			`Platform A2A evidence discovery.target did not match target agent ${expected.toAgentId}`,
		);
	}
	if (!origin.matchedAgentIds.includes(expected.fromAgentId)) {
		throw new Error(
			`Platform A2A evidence discovery.origin did not match origin agent ${expected.fromAgentId}`,
		);
	}
	if (
		expected.requireDiscoveryEvidence &&
		(!target.sourceEvidencePresent || !origin.sourceEvidencePresent)
	) {
		throw new Error(
			"Platform A2A evidence requires source Agent Registry discovery evidence",
		);
	}
	return {
		targetSourceEvidencePresent: target.sourceEvidencePresent,
		originSourceEvidencePresent: origin.sourceEvidencePresent,
		targetTraceId: target.traceId,
		originTraceId: origin.traceId,
	};
}

function verifyDiscoverySection(
	value: unknown,
	name: string,
	expected: {
		workspaceId: string;
		organizationId: string;
		skillId?: string;
		capability?: string;
	},
	options: {
		requireRequestedFilters?: boolean;
		requireSourceScope?: boolean;
	} = {},
): {
	sourceEvidencePresent: boolean;
	matchedAgentIds: string[];
	traceId?: string;
} {
	const section = requireRecord(value, name);
	const surface = requireString(section, "surface");
	if (surface !== "platform-agent-registry-peer-discovery") {
		throw new Error(
			`Platform A2A evidence ${name}.surface is unsupported: ${surface}`,
		);
	}
	const query = requireRecord(section.query, `${name}.query`);
	const queryWorkspaceId = requireString(query, "workspaceId");
	const queryOrganizationId = requireString(query, "organizationId");
	if (queryWorkspaceId !== expected.workspaceId) {
		throw new Error(
			`Platform A2A evidence ${name}.query.workspaceId ${queryWorkspaceId} does not match workspaceId ${expected.workspaceId}`,
		);
	}
	if (queryOrganizationId !== expected.organizationId) {
		throw new Error(
			`Platform A2A evidence ${name}.query.organizationId ${queryOrganizationId} does not match organizationId ${expected.organizationId}`,
		);
	}
	requireBooleanTrue(query, "requireA2ADispatch", `${name}.query`);
	const result = requireRecord(section.result, `${name}.result`);
	if (options.requireRequestedFilters) {
		verifyRequestedDiscoveryFilters(name, query, result, expected);
	}
	const resultWorkspaceId = optionalString(result, "workspaceId");
	const resultOrganizationId = optionalString(result, "organizationId");
	if (!resultWorkspaceId) {
		if (options.requireSourceScope) {
			throw new Error(
				`Platform A2A evidence ${name}.result.workspaceId missing does not match workspaceId ${expected.workspaceId}`,
			);
		}
	} else if (resultWorkspaceId !== expected.workspaceId) {
		throw new Error(
			`Platform A2A evidence ${name}.result.workspaceId ${resultWorkspaceId} does not match workspaceId ${expected.workspaceId}`,
		);
	}
	if (!resultOrganizationId) {
		if (options.requireSourceScope) {
			throw new Error(
				`Platform A2A evidence ${name}.result.organizationId missing does not match organizationId ${expected.organizationId}`,
			);
		}
	} else if (resultOrganizationId !== expected.organizationId) {
		throw new Error(
			`Platform A2A evidence ${name}.result.organizationId ${resultOrganizationId} does not match organizationId ${expected.organizationId}`,
		);
	}
	const sourceEvidencePresent = requireBoolean(
		section,
		"sourceEvidencePresent",
		name,
	);
	const candidateCount = requireNonNegativeInteger(
		result,
		"candidateCount",
		`${name}.result`,
	);
	const matchedCount = requireNonNegativeInteger(
		result,
		"matchedCount",
		`${name}.result`,
	);
	if (candidateCount < matchedCount) {
		throw new Error(
			`Platform A2A evidence ${name}.result candidateCount ${candidateCount} is lower than matchedCount ${matchedCount}`,
		);
	}
	const matchedAgentIds = requireStringArray(
		result,
		"matchedAgentIds",
		`${name}.result`,
	);
	if (matchedAgentIds.length < 1) {
		throw new Error(
			`Platform A2A evidence ${name}.result matchedAgentIds is empty`,
		);
	}
	if (matchedCount !== matchedAgentIds.length) {
		throw new Error(
			`Platform A2A evidence ${name}.result matchedCount ${matchedCount} does not match matchedAgentIds length ${matchedAgentIds.length}`,
		);
	}
	return {
		sourceEvidencePresent,
		matchedAgentIds,
		traceId: optionalString(result, "traceId"),
	};
}

function verifyRequestedDiscoveryFilters(
	name: string,
	query: Record<string, unknown>,
	result: Record<string, unknown>,
	expected: {
		skillId?: string;
		capability?: string;
	},
): void {
	if (!expected.skillId && !expected.capability) {
		throw new Error(
			`Platform A2A evidence ${name} requires an input skillId or capability for strict discovery verification`,
		);
	}
	if (expected.skillId) {
		const querySkillId = optionalString(query, "skillId");
		if (querySkillId !== expected.skillId) {
			throw new Error(
				`Platform A2A evidence ${name}.query.skillId ${querySkillId ?? "missing"} does not match inputs.skillId ${expected.skillId}`,
			);
		}
		const resultSkillId = optionalString(result, "a2aSkillId");
		if (resultSkillId !== expected.skillId) {
			throw new Error(
				`Platform A2A evidence ${name}.result.a2aSkillId ${resultSkillId ?? "missing"} does not match inputs.skillId ${expected.skillId}`,
			);
		}
	}
	if (expected.capability) {
		const queryCapability = optionalString(query, "capability");
		if (queryCapability !== expected.capability) {
			throw new Error(
				`Platform A2A evidence ${name}.query.capability ${queryCapability ?? "missing"} does not match inputs.capability ${expected.capability}`,
			);
		}
		const resultCapability = optionalString(result, "capability");
		const resultCapabilities = optionalStringArray(result, "capabilities");
		if (
			resultCapability !== expected.capability &&
			!resultCapabilities.includes(expected.capability)
		) {
			const actual =
				resultCapability ??
				(resultCapabilities.length > 0
					? `[${resultCapabilities.join(", ")}]`
					: "missing");
			throw new Error(
				`Platform A2A evidence ${name}.result.capability ${actual} does not match inputs.capability ${expected.capability}`,
			);
		}
	}
}

function verifyNegativeAuthProbe(
	value: unknown,
	options: PlatformA2ALiveEvidenceVerificationOptions,
): PlatformA2ALiveEvidenceVerification["negativeAuthProbe"] | undefined {
	if (value === undefined || value === null) {
		if (options.requireNegativeAuthProbe) {
			throw new Error(
				"Platform A2A evidence requires invalid-token rejection evidence",
			);
		}
		return undefined;
	}
	const probe = requireRecord(value, "negativeAuthProbe");
	const surface = requireString(probe, "surface");
	if (surface !== "platform-agent-registry-peer-discovery") {
		throw new Error(
			`Platform A2A evidence invalid-token probe has unsupported surface: ${surface}`,
		);
	}
	if (probe.rejected !== true) {
		throw new Error(
			"Platform A2A evidence invalid-token probe is not marked rejected",
		);
	}
	const errorClass = requireString(probe, "errorClass");
	if (errorClass !== "unauthorized" && errorClass !== "forbidden") {
		throw new Error(
			`Platform A2A evidence invalid-token probe has unsupported error class: ${errorClass}`,
		);
	}
	requireString(probe, "observedAt");
	return {
		surface,
		errorClass,
		rejected: true,
	};
}

function verifyRealtimeDeliveryEvidence(
	value: unknown,
	input: {
		options: PlatformA2ALiveEvidenceVerificationOptions;
		workspaceId: string;
		a2aTaskId: string;
		a2aMessageId?: string;
		contextId?: string;
		taskState?: string;
		taskTerminal: boolean;
		taskMessageIds: string[];
	},
): PlatformA2ALiveEvidenceVerification["realtimeDelivery"] | undefined {
	if (value === undefined || value === null) {
		if (input.options.requireRealtimeDeliveryEvidence) {
			throw new Error(
				"Platform A2A evidence requires realtime delivery evidence",
			);
		}
		return undefined;
	}
	const delivery = requireRecord(value, "realtimeDelivery");
	const trace = verifyRealtimeDeliveryTrace(
		requireRealtimeSection(delivery, "trace"),
	);
	const stream = verifyRealtimeStreamEvidence(
		requireRealtimeSection(delivery, "stream"),
		{ ...input, rootTraceId: trace.rootTraceId },
	);
	const push = verifyRealtimePushEvidence(
		requireRealtimeSection(delivery, "push"),
		{ ...input, rootTraceId: trace.rootTraceId },
	);
	const metrics = verifyRealtimeMetricsEvidence(
		requireRealtimeSection(delivery, "metrics"),
		input.workspaceId,
		[...stream.observedAt, ...push.observedAt],
	);
	return {
		streamTerminalEventId: stream.terminalEventId,
		pushTerminalNotificationId: push.terminalNotificationId,
		metricQueryId: metrics.queryId,
		rootTraceId: trace.rootTraceId,
	};
}

function requireRealtimeSection(
	record: Record<string, unknown>,
	key: "metrics" | "push" | "stream" | "trace",
): Record<string, unknown> {
	const value = record[key];
	if (value === undefined || value === null) {
		throw new Error(`Platform A2A evidence requires realtime delivery ${key}`);
	}
	return requireRecord(value, `realtimeDelivery.${key}`);
}

function verifyRealtimeDeliveryTrace(
	trace: Record<string, unknown>,
): { rootTraceId: string } {
	const rootTraceId = requireTraceId(
		trace,
		"rootTraceId",
		"realtimeDelivery.trace",
	);
	for (const key of ["taskTraceId", "streamTraceId", "pushTraceId"] as const) {
		const value = requireTraceId(trace, key, "realtimeDelivery.trace");
		if (value !== rootTraceId) {
			throw new Error(
				`Platform A2A evidence realtime delivery trace ${key} ${value} does not match rootTraceId ${rootTraceId}`,
			);
		}
	}
	requireBooleanTrue(trace, "correlated", "realtimeDelivery.trace");
	return { rootTraceId };
}

function verifyRealtimeStreamEvidence(
	stream: Record<string, unknown>,
	expected: {
		rootTraceId: string;
		a2aTaskId: string;
		a2aMessageId?: string;
		contextId?: string;
		taskState?: string;
		taskTerminal: boolean;
		taskMessageIds: string[];
	},
): { observedAt: string[]; terminalEventId: string } {
	const surface = requireString(stream, "surface");
	if (surface !== "a2a-task-status-stream") {
		throw new Error(
			`Platform A2A evidence realtime stream surface is unsupported: ${surface}`,
		);
	}
	requireBooleanTrue(stream, "sourceEvidencePresent", "realtimeDelivery.stream");
	const traceparent = requireString(stream, "traceparent");
	verifyTraceparent(traceparent, expected.rootTraceId, "realtimeDelivery.stream");
	const terminalEventId = requireString(stream, "terminalEventId");
	const streamArtifactIds = requireStringArray(
		stream,
		"artifactIds",
		"realtimeDelivery.stream",
	);
	if (streamArtifactIds.length < 1) {
		throw new Error(
			"Platform A2A evidence realtime stream requires artifactIds",
		);
	}
	const events = requireRecordArray(
		stream,
		"events",
		"realtimeDelivery.stream",
	);
	const seenIds = new Set<string>();
	let terminalEvent: Record<string, unknown> | undefined;
	const observedAt: string[] = [];
	for (const event of events) {
		const id = requireString(event, "id");
		const type = optionalString(event, "type");
		if (type && !REALTIME_STREAM_EVENT_TYPES.has(type)) {
			throw new Error(
				`Platform A2A evidence unsupported realtime stream event type ${type} for event ${id}`,
			);
		}
		if (terminalEvent) {
			throw new Error(
				`Platform A2A evidence realtime stream event ${id} appears after terminalEventId ${terminalEventId}`,
			);
		}
		if (seenIds.has(id)) {
			throw new Error(
				`Platform A2A evidence realtime stream has duplicate event id ${id}`,
			);
		}
		seenIds.add(id);
		verifyRealtimeDeliveryRecordIds(
			event,
			`realtime stream event ${id}`,
			expected,
		);
		observedAt.push(
			requireTimestampString(event, "observedAt", `realtime stream event ${id}`),
		);
		requireBoolean(event, "terminal", `realtimeDelivery.stream.events.${id}`);
		if (id === terminalEventId) {
			terminalEvent = event;
		}
	}
	if (!terminalEvent) {
		throw new Error(
			`Platform A2A evidence realtime stream terminalEventId ${terminalEventId} is not present in events`,
		);
	}
	verifyTerminalRealtimeRecord(
		terminalEvent,
		`realtime stream event ${terminalEventId}`,
		expected,
	);
	const terminalArtifactIds = optionalStringArray(terminalEvent, "artifactIds");
	if (
		isRealtimeArtifactStreamEvent(terminalEvent) &&
		terminalArtifactIds.length < 1
	) {
		throw new Error(
			`Platform A2A evidence realtime stream event ${terminalEventId} requires artifactIds`,
		);
	}
	return { observedAt, terminalEventId };
}

function verifyRealtimePushEvidence(
	push: Record<string, unknown>,
	expected: {
		rootTraceId: string;
		a2aTaskId: string;
		a2aMessageId?: string;
		contextId?: string;
		taskState?: string;
		taskTerminal: boolean;
		taskMessageIds: string[];
	},
): { observedAt: string[]; terminalNotificationId: string } {
	const surface = requireString(push, "surface");
	if (surface !== "a2a-task-push-notification") {
		throw new Error(
			`Platform A2A evidence realtime push surface is unsupported: ${surface}`,
		);
	}
	requireBooleanTrue(push, "sourceEvidencePresent", "realtimeDelivery.push");
	requireString(push, "callbackAuditId");
	const traceparent = requireString(push, "traceparent");
	verifyTraceparent(traceparent, expected.rootTraceId, "realtimeDelivery.push");
	const terminalNotificationId = requireString(push, "terminalNotificationId");
	const acceptedCount = requireNonNegativeInteger(
		push,
		"acceptedCount",
		"realtimeDelivery.push",
	);
	const rejectedCount = requireNonNegativeInteger(
		push,
		"rejectedCount",
		"realtimeDelivery.push",
	);
	requireBooleanTrue(push, "invalidTokenRejected", "realtimeDelivery.push");
	if (rejectedCount < 1) {
		throw new Error(
			"Platform A2A evidence realtime push requires at least one rejected callback notification",
		);
	}
	const notifications = requireRecordArray(
		push,
		"notifications",
		"realtimeDelivery.push",
	);
	const seenIds = new Set<string>();
	let terminalNotification: Record<string, unknown> | undefined;
	let actualAcceptedCount = 0;
	let actualRejectedCount = 0;
	let authRejectedNotification = false;
	const observedAt: string[] = [];
	for (const notification of notifications) {
		const id = requireString(notification, "id");
		if (seenIds.has(id)) {
			throw new Error(
				`Platform A2A evidence realtime push has duplicate notification id ${id}`,
			);
		}
		seenIds.add(id);
		verifyRealtimeDeliveryRecordIds(
			notification,
			`realtime push notification ${id}`,
			expected,
		);
		observedAt.push(
			requireTimestampString(
				notification,
				"observedAt",
				`realtime push notification ${id}`,
			),
		);
		if (
			requireBoolean(
				notification,
				"accepted",
				`realtimeDelivery.push.notifications.${id}`,
			)
		) {
			actualAcceptedCount += 1;
		} else {
			actualRejectedCount += 1;
			const errorClass = optionalString(notification, "errorClass");
			if (errorClass === "unauthorized" || errorClass === "forbidden") {
				authRejectedNotification = true;
			}
		}
		requireBoolean(
			notification,
			"terminal",
			`realtimeDelivery.push.notifications.${id}`,
		);
		if (id === terminalNotificationId) {
			terminalNotification = notification;
		}
	}
	if (actualAcceptedCount !== acceptedCount) {
		throw new Error(
			`Platform A2A evidence realtime push acceptedCount ${acceptedCount} does not match accepted notifications ${actualAcceptedCount}`,
		);
	}
	if (actualRejectedCount !== rejectedCount) {
		throw new Error(
			`Platform A2A evidence realtime push rejectedCount ${rejectedCount} does not match rejected notifications ${actualRejectedCount}`,
		);
	}
	if (!authRejectedNotification) {
		throw new Error(
			"Platform A2A evidence realtime push invalidTokenRejected requires at least one rejected notification with unauthorized or forbidden errorClass",
		);
	}
	if (!terminalNotification) {
		throw new Error(
			`Platform A2A evidence realtime push terminalNotificationId ${terminalNotificationId} is not present in notifications`,
		);
	}
	verifyTerminalRealtimeRecord(
		terminalNotification,
		`realtime push notification ${terminalNotificationId}`,
		expected,
	);
	if (
		requireBoolean(
			terminalNotification,
			"accepted",
			`realtimeDelivery.push.notifications.${terminalNotificationId}`,
		) !== true
	) {
		throw new Error(
			`Platform A2A evidence realtime push notification ${terminalNotificationId} is not accepted`,
		);
	}
	return { observedAt, terminalNotificationId };
}

function verifyRealtimeMetricsEvidence(
	metrics: Record<string, unknown>,
	workspaceId: string,
	deliveryObservedAt: string[],
): { queryId: string } {
	const surface = requireString(metrics, "surface");
	if (surface !== "platform-observability-delivery-metrics") {
		throw new Error(
			`Platform A2A evidence realtime delivery metrics surface is unsupported: ${surface}`,
		);
	}
	requireBooleanTrue(
		metrics,
		"sourceEvidencePresent",
		"realtimeDelivery.metrics",
	);
	const queryId = requireString(metrics, "queryId");
	const metricsWorkspaceId = requireString(metrics, "workspaceId");
	if (metricsWorkspaceId !== workspaceId) {
		throw new Error(
			`Platform A2A evidence realtime delivery metrics workspaceId ${metricsWorkspaceId} does not match workspaceId ${workspaceId}`,
		);
	}
	const windowStart = requireTimestampString(
		metrics,
		"windowStart",
		"realtimeDelivery.metrics",
	);
	const windowEnd = requireTimestampString(
		metrics,
		"windowEnd",
		"realtimeDelivery.metrics",
	);
	verifyMetricsWindowIncludesObservedDeliveries(
		windowStart,
		windowEnd,
		deliveryObservedAt,
	);
	requireNumberInRange(
		metrics,
		"streamTerminalRate",
		"realtimeDelivery.metrics",
		0,
		1,
	);
	requireNonNegativeNumber(
		metrics,
		"pushDeliveryLatencyMsP95",
		"realtimeDelivery.metrics",
	);
	requireNumberInRange(
		metrics,
		"callbackRejectionRate",
		"realtimeDelivery.metrics",
		0,
		1,
	);
	requireNonNegativeInteger(metrics, "retryCount", "realtimeDelivery.metrics");
	requireNonNegativeInteger(
		metrics,
		"stuckDeliveryAlerts",
		"realtimeDelivery.metrics",
	);
	return { queryId };
}

function verifyMetricsWindowIncludesObservedDeliveries(
	windowStart: string,
	windowEnd: string,
	deliveryObservedAt: string[],
): void {
	const windowStartMs = parseTimestampMs(windowStart);
	const windowEndMs = parseTimestampMs(windowEnd);
	if (windowStartMs > windowEndMs) {
		throw new Error(
			"Platform A2A evidence realtime delivery metrics windowStart must be before or equal to windowEnd",
		);
	}
	const observedTimesMs = deliveryObservedAt.map((value) =>
		parseTimestampMs(value),
	);
	const firstObservedMs = Math.min(...observedTimesMs);
	const lastObservedMs = Math.max(...observedTimesMs);
	if (windowStartMs > firstObservedMs || windowEndMs < lastObservedMs) {
		throw new Error(
			"Platform A2A evidence realtime delivery metrics window must include observed stream and push deliveries",
		);
	}
}

function verifyRealtimeDeliveryRecordIds(
	record: Record<string, unknown>,
	label: string,
	expected: {
		a2aTaskId: string;
		a2aMessageId?: string;
		contextId?: string;
		taskMessageIds: string[];
	},
): void {
	const taskId = requireString(record, "taskId");
	if (taskId !== expected.a2aTaskId) {
		throw new Error(
			`Platform A2A evidence ${label} taskId ${taskId} does not match delegation.a2aTaskId ${expected.a2aTaskId}`,
		);
	}
	const contextId = optionalString(record, "contextId");
	if (expected.contextId && contextId !== expected.contextId) {
		throw new Error(
			`Platform A2A evidence ${label} contextId ${contextId ?? "missing"} does not match task.contextId ${expected.contextId}`,
		);
	}
	const messageId = optionalString(record, "messageId");
	if (messageId && !expected.taskMessageIds.includes(messageId)) {
		throw new Error(
			`Platform A2A evidence ${label} messageId ${messageId} is not present in task.messageIds`,
		);
	}
}

function isRealtimeArtifactStreamEvent(record: Record<string, unknown>): boolean {
	const type = optionalString(record, "type");
	return type === "task-artifact" || type === "artifactUpdate";
}

function verifyTerminalRealtimeRecord(
	record: Record<string, unknown>,
	label: string,
	expected: {
		taskState?: string;
		taskTerminal: boolean;
	},
): void {
	if (requireBoolean(record, "terminal", label) !== true) {
		throw new Error(`Platform A2A evidence ${label} is not terminal`);
	}
	if (!expected.taskTerminal) {
		throw new Error(
			`Platform A2A evidence ${label} is terminal but task.terminal is false`,
		);
	}
	const state = optionalString(record, "state");
	const shouldValidateState = state || !isRealtimeArtifactStreamEvent(record);
	if (expected.taskState && shouldValidateState && state !== expected.taskState) {
		throw new Error(
			`Platform A2A evidence ${label} state ${state ?? "missing"} does not match task.state ${expected.taskState}`,
		);
	}
}

async function verifyDetachedSignature(
	evidencePath: string,
	evidenceBytes: string,
	evidenceDigest: string,
	options: PlatformA2ALiveEvidenceVerificationOptions,
): Promise<PlatformA2ALiveEvidenceVerification["signature"] | undefined> {
	const signaturePath = `${evidencePath}.sig.json`;
	const signatureBytes = await readOptionalFile(signaturePath);
	if (!signatureBytes) {
		if (options.requireSignature) {
			throw new Error(
				`Platform A2A evidence requires a detached signature sidecar: ${signaturePath}`,
			);
		}
		return undefined;
	}
	const publicKeyPem = await resolveVerificationPublicKey(options);
	if (!publicKeyPem) {
		if (options.requireSignature) {
			throw new Error(
				"Platform A2A evidence signature verification requires a trusted public key",
			);
		}
		return undefined;
	}
	const signature = requireRecord(
		JSON.parse(signatureBytes) as unknown,
		"signature",
	);
	const protocolVersion = requireString(signature, "protocolVersion");
	if (protocolVersion !== SIGNATURE_PROTOCOL_VERSION) {
		throw new Error(
			`unexpected Platform A2A evidence signature protocol ${protocolVersion}`,
		);
	}
	const algorithm = requireString(signature, "algorithm");
	if (algorithm !== "ed25519") {
		throw new Error(
			`Platform A2A evidence signature algorithm is not supported: ${algorithm}`,
		);
	}
	const signedDigest = requireString(signature, "evidenceSha256");
	if (signedDigest !== evidenceDigest) {
		throw new Error(
			`Platform A2A evidence signature digest mismatch: expected ${evidenceDigest}, got ${signedDigest}`,
		);
	}
	const publicKey = createPublicKey(normalizePem(publicKeyPem));
	if (publicKey.asymmetricKeyType !== "ed25519") {
		throw new Error(
			`Platform A2A evidence verification requires an Ed25519 public key, got ${publicKey.asymmetricKeyType ?? "unknown"}`,
		);
	}
	const expectedFingerprint = fingerprintPublicKeyPem(publicKeyPem);
	const signedFingerprint = requireString(
		signature,
		"publicKeyFingerprintSha256",
	);
	if (signedFingerprint !== expectedFingerprint) {
		throw new Error(
			`Platform A2A evidence signature key fingerprint mismatch: expected ${expectedFingerprint}, got ${signedFingerprint}`,
		);
	}
	const signatureValue = requireString(signature, "signature");
	const ok = verifyBytes(
		null,
		Buffer.from(evidenceBytes),
		publicKey,
		Buffer.from(signatureValue, "base64"),
	);
	if (!ok) {
		throw new Error("Platform A2A evidence detached signature is invalid");
	}
	return {
		algorithm: "ed25519",
		keyId: optionalString(signature, "keyId"),
		publicKeyFingerprintSha256: expectedFingerprint,
		signaturePath,
		verified: true,
	};
}

async function readOptionalFile(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return undefined;
		}
		throw error;
	}
}

async function resolveVerificationPublicKey(
	options: PlatformA2ALiveEvidenceVerificationOptions,
): Promise<string | undefined> {
	if (options.publicKeyPem) {
		return normalizePem(options.publicKeyPem);
	}
	if (options.publicKeyPath) {
		return normalizePem(await readFile(options.publicKeyPath, "utf8"));
	}
	const env = options.env ?? process.env;
	const inlineKey = firstEnv(env, VERIFICATION_KEY_ENV_VARS);
	if (inlineKey) {
		return normalizePem(inlineKey);
	}
	const keyFile = firstEnv(env, VERIFICATION_KEY_FILE_ENV_VARS);
	if (keyFile) {
		return normalizePem(await readFile(keyFile, "utf8"));
	}
	return undefined;
}

function firstEnv(env: Env, names: readonly string[]): string | undefined {
	for (const name of names) {
		const value = env[name]?.trim();
		if (value) {
			return value;
		}
	}
	return undefined;
}

function parseSidecarDigest(sidecar: string): string {
	const digest = sidecar.trim().split(/\s+/u)[0];
	if (!digest || !/^[a-f0-9]{64}$/u.test(digest)) {
		throw new Error("Platform A2A evidence sidecar does not contain a SHA-256 digest");
	}
	return digest;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Platform A2A evidence field ${name} is not an object`);
	}
	return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Platform A2A evidence field ${key} is missing`);
	}
	return value.trim();
}

function optionalString(
	record: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = record[key];
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Platform A2A evidence field ${key} must be a string`);
	}
	return value.trim();
}

function optionalStringArray(record: Record<string, unknown>, key: string): string[] {
	const value = record[key];
	if (value === undefined || value === null) {
		return [];
	}
	if (!Array.isArray(value)) {
		throw new Error(`Platform A2A evidence field ${key} must be an array`);
	}
	return value.map((item) => {
		if (typeof item !== "string" || item.trim().length === 0) {
			throw new Error(
				`Platform A2A evidence field ${key} must contain only strings`,
			);
		}
		return item.trim();
	});
}

function requireBoolean(
	record: Record<string, unknown>,
	key: string,
	name: string,
): boolean {
	const value = record[key];
	if (typeof value !== "boolean") {
		throw new Error(`Platform A2A evidence field ${name}.${key} must be a boolean`);
	}
	return value;
}

function requireBooleanTrue(
	record: Record<string, unknown>,
	key: string,
	name: string,
): void {
	if (requireBoolean(record, key, name) !== true) {
		throw new Error(`Platform A2A evidence field ${name}.${key} must be true`);
	}
}

function requireNonNegativeInteger(
	record: Record<string, unknown>,
	key: string,
	name: string,
): number {
	const value = record[key];
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < 0
	) {
		throw new Error(
			`Platform A2A evidence field ${name}.${key} must be a non-negative integer`,
		);
	}
	return value;
}

function requireNonNegativeNumber(
	record: Record<string, unknown>,
	key: string,
	name: string,
): number {
	const value = record[key];
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(
			`Platform A2A evidence field ${name}.${key} must be a non-negative number`,
		);
	}
	return value;
}

function requireNumberInRange(
	record: Record<string, unknown>,
	key: string,
	name: string,
	min: number,
	max: number,
): number {
	const value = record[key];
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < min ||
		value > max
	) {
		throw new Error(
			`Platform A2A evidence field ${name}.${key} must be between ${min} and ${max}`,
		);
	}
	return value;
}

function requireStringArray(
	record: Record<string, unknown>,
	key: string,
	name: string,
): string[] {
	const value = record[key];
	if (!Array.isArray(value)) {
		throw new Error(`Platform A2A evidence field ${name}.${key} must be an array`);
	}
	const strings = value.map((item) => {
		if (typeof item !== "string" || item.trim().length === 0) {
			throw new Error(
				`Platform A2A evidence field ${name}.${key} must contain only strings`,
			);
		}
		return item.trim();
	});
	return strings;
}

function requireRecordArray(
	record: Record<string, unknown>,
	key: string,
	name: string,
): Record<string, unknown>[] {
	const value = record[key];
	if (!Array.isArray(value) || value.length < 1) {
		throw new Error(
			`Platform A2A evidence field ${name}.${key} must be a non-empty array`,
		);
	}
	return value.map((item, index) =>
		requireRecord(item, `${name}.${key}[${index}]`),
	);
}

function requireTimestampString(
	record: Record<string, unknown>,
	key: string,
	name: string,
): string {
	const value = requireString(record, key);
	if (Number.isNaN(parseTimestampMs(value))) {
		throw new Error(
			`Platform A2A evidence field ${name}.${key} must be a timestamp`,
		);
	}
	return value;
}

function parseTimestampMs(value: string): number {
	return new Date(value).getTime();
}

function verifyGithubEvidence(
	value: unknown,
): VerifiedGithubEvidence | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	const github = requireRecord(value, "github");
	const repository = optionalString(github, "repository");
	if (repository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
		throw new Error(
			`Platform A2A evidence GitHub repository is not owner/repo: ${repository}`,
		);
	}
	const sha = optionalString(github, "sha");
	if (sha) {
		assertRealishGitSha(sha);
	}
	const runId =
		integerStringField(github, "runId") ??
		integerStringField(github, "actionsRunId") ??
		integerStringField(github, "ghaRunId");
	const runUrl = optionalString(github, "runUrl");
	const runUrlId = runUrl ? githubActionsRunIdFromUrl(runUrl) : undefined;
	if (runUrl && !runUrlId) {
		throw new Error(
			`Platform A2A evidence GitHub run URL is not dereferenceable: ${runUrl}`,
		);
	}
	if (runId && runUrlId && runUrlId !== runId) {
		throw new Error(
			`Platform A2A evidence GitHub run URL id ${runUrlId} does not match runId ${runId}`,
		);
	}
	const pullRequestNumber =
		positiveIntegerField(github, "pullRequestNumber") ??
		positiveIntegerField(github, "prNumber") ??
		pullRequestIdentifier(github, "pullRequest") ??
		pullRequestIdentifier(github, "pullRequestRef") ??
		pullRequestIdentifier(github, "pr");
	const pullRequestUrl = optionalString(github, "pullRequestUrl");
	if (pullRequestUrl && !/\/pull\/[1-9]\d*(?:$|[/?#])/u.test(pullRequestUrl)) {
		throw new Error(
			`Platform A2A evidence GitHub PR URL is not dereferenceable: ${pullRequestUrl}`,
		);
	}
	const serverUrl = githubServerUrl(
		optionalString(github, "serverUrl") ??
			githubServerUrlFromWebUrl(runUrl) ??
			githubServerUrlFromWebUrl(pullRequestUrl),
	);
	return { repository, serverUrl, runId, pullRequestNumber, sha };
}

async function verifyDereferenceableGithubEvidence(
	github: VerifiedGithubEvidence | undefined,
	options: PlatformA2ALiveEvidenceVerificationOptions,
): Promise<true | undefined> {
	if (!options.requireDereferenceableGithub) {
		return undefined;
	}
	if (!github?.repository) {
		throw new Error(
			"Platform A2A evidence requires dereferenceable GitHub metadata but has no repository",
		);
	}
	if (!github.runId) {
		throw new Error(
			"Platform A2A evidence requires dereferenceable GitHub metadata but has no Actions run id",
		);
	}
	requireHttpsGithubServerUrl(github.serverUrl);
	const env = options.env ?? process.env;
	const apiClient = options.githubApiClient ?? defaultGithubApiClient;
	const run = requireRecord(
		await apiClient(
			`/repos/${github.repository}/actions/runs/${github.runId}`,
			env,
			github.serverUrl,
		),
		"github.actionsRun",
	);
	const actualRunId = integerishRecordField(run, "id");
	if (actualRunId !== github.runId) {
		throw new Error(
			`Platform A2A evidence GitHub run id mismatch: expected ${github.runId}, got ${actualRunId}`,
		);
	}
	if (github.pullRequestNumber !== undefined) {
		const pullRequest = requireRecord(
			await apiClient(
				`/repos/${github.repository}/pulls/${github.pullRequestNumber}`,
				env,
				github.serverUrl,
			),
			"github.pullRequest",
		);
		const actualPullRequestNumber = integerishRecordField(pullRequest, "number");
		if (actualPullRequestNumber !== String(github.pullRequestNumber)) {
			throw new Error(
				`Platform A2A evidence GitHub PR number mismatch: expected ${github.pullRequestNumber}, got ${actualPullRequestNumber}`,
			);
		}
	}
	return true;
}

function githubActionsRunIdFromUrl(value: string): string | undefined {
	return /\/actions\/runs\/([1-9]\d*)(?:$|[/?#])/u.exec(value)?.[1];
}

function requireHttpsGithubServerUrl(serverUrl: string | undefined): void {
	if (!serverUrl) {
		return;
	}
	const url = new URL(serverUrl);
	if (url.protocol !== "https:") {
		throw new Error(
			`Platform A2A evidence GitHub server URL must use HTTPS when dereference is required: ${serverUrl}`,
		);
	}
}

function githubServerUrl(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") {
			throw new Error("unsupported protocol");
		}
		url.hash = "";
		url.search = "";
		url.pathname = url.pathname.replace(/\/+$/u, "");
		return `${url.origin}${url.pathname}`;
	} catch (error) {
		throw new Error(
			`Platform A2A evidence GitHub server URL is invalid: ${value}`,
			{ cause: error },
		);
	}
}

function githubServerUrlFromWebUrl(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") {
			return undefined;
		}
		return `${url.protocol}//${url.host}`;
	} catch {
		return undefined;
	}
}

function githubRestApiBaseUrl(serverUrl: string | undefined): string {
	const normalizedServerUrl = githubServerUrl(serverUrl) ?? "https://github.com";
	if (normalizedServerUrl === "https://github.com") {
		return "https://api.github.com";
	}
	return `${new URL(normalizedServerUrl).origin}/api/v3`;
}

async function defaultGithubApiClient(
	path: string,
	env: Env,
	serverUrl: string | undefined,
): Promise<unknown> {
	const token = firstEnv(env, ["GITHUB_TOKEN", "GH_TOKEN"]);
	const response = await fetch(`${githubRestApiBaseUrl(serverUrl)}${path}`, {
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
	});
	if (!response.ok) {
		const body = await response.text();
		throw new Error(
			`Platform A2A evidence GitHub dereference failed for ${path}: HTTP ${response.status} ${body.slice(0, 200)}`,
		);
	}
	return await response.json();
}

function integerishRecordField(
	record: Record<string, unknown>,
	key: string,
): string {
	const value = record[key];
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
		return String(value);
	}
	if (typeof value === "string" && /^[1-9]\d*$/u.test(value.trim())) {
		return value.trim();
	}
	throw new Error(`Platform A2A evidence GitHub API field ${key} is not an id`);
}

function integerStringField(
	record: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = record[key];
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
		return String(value);
	}
	if (typeof value === "string" && /^[1-9]\d*$/u.test(value.trim())) {
		return value.trim();
	}
	throw new Error(
		`Platform A2A evidence GitHub ${key} must be a positive integer id`,
	);
}

function positiveIntegerField(
	record: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = record[key];
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
		return value;
	}
	if (typeof value === "string" && /^[1-9]\d*$/u.test(value.trim())) {
		return Number(value.trim());
	}
	throw new Error(
		`Platform A2A evidence GitHub ${key} must be a positive integer`,
	);
}

function pullRequestIdentifier(
	record: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = record[key];
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
		return value;
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		const numeric = trimmed.match(/^#?([1-9]\d*)$/u);
		if (numeric?.[1]) {
			return Number(numeric[1]);
		}
		const url = trimmed.match(/\/pull\/([1-9]\d*)(?:$|[/?#])/u);
		if (url?.[1]) {
			return Number(url[1]);
		}
	}
	throw new Error(
		`Platform A2A evidence GitHub ${key} must be an integer PR number or /pull/<number> URL`,
	);
}

function assertRealishGitSha(gitSha: string): void {
	if (!/^[a-f0-9]{40}$/u.test(gitSha)) {
		throw new Error(`Platform A2A evidence git SHA is not a 40-hex SHA: ${gitSha}`);
	}
	if (/c0de5afe/u.test(gitSha) || /0{12,}$/u.test(gitSha)) {
		throw new Error(`Platform A2A evidence git SHA looks synthetic: ${gitSha}`);
	}
}

function requireTraceId(
	record: Record<string, unknown>,
	key: string,
	name: string,
): string {
	return normalizeTraceId(requireString(record, key), `${name}.${key}`);
}

function normalizeTraceId(value: string, name: string): string {
	const traceId = value.trim().toLowerCase();
	if (!/^[a-f0-9]{32}$/u.test(traceId) || /^0{32}$/u.test(traceId)) {
		throw new Error(
			`Platform A2A evidence field ${name} must be a non-zero 32-hex trace id`,
		);
	}
	return traceId;
}

function verifyTraceparent(
	value: string,
	rootTraceId: string,
	name: string,
): void {
	const match = value
		.trim()
		.toLowerCase()
		.match(/^00-([a-f0-9]{32})-([a-f0-9]{16})-[a-f0-9]{2}$/u);
	if (
		!match?.[1] ||
		!match[2] ||
		/^0{32}$/u.test(match[1]) ||
		/^0{16}$/u.test(match[2])
	) {
		throw new Error(
			`Platform A2A evidence ${name}.traceparent must be a W3C traceparent`,
		);
	}
	if (match[1] !== rootTraceId) {
		throw new Error(
			`Platform A2A evidence ${name}.traceparent trace id ${match[1]} does not match rootTraceId ${rootTraceId}`,
		);
	}
}

function assertNoSyntheticProofId(record: Record<string, unknown>): void {
	for (const [key, value] of [
		["proofId", record.proofId],
		["evidenceId", record.evidenceId],
	] as const) {
		if (typeof value === "string" && looksLocalProofId(value)) {
			throw new Error(
				`Platform A2A evidence ${key} looks like a local synthetic proof id: ${value}`,
			);
		}
	}
	if (record.proof !== undefined) {
		const proof = requireRecord(record.proof, "proof");
		const id = optionalString(proof, "id");
		if (id && looksLocalProofId(id)) {
			throw new Error(
				`Platform A2A evidence proof.id looks like a local synthetic proof id: ${id}`,
			);
		}
	}
}

function looksLocalProofId(value: string): boolean {
	return /(^|[-_])(local|fixture|replay)([-_]|$)/iu.test(value);
}

function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function fingerprintPublicKeyPem(publicKeyPem: string): string {
	const publicKey = createPublicKey(normalizePem(publicKeyPem));
	const publicDer = publicKey.export({ format: "der", type: "spki" });
	return createHash("sha256").update(publicDer).digest("hex");
}

function normalizePem(value: string): string {
	return value.includes("\\n") ? value.replace(/\\n/gu, "\n") : value;
}

function booleanEnv(value: string | undefined): boolean {
	return value === "1" || value === "true";
}

function isEntrypoint(): boolean {
	const entrypoint = process.argv[1];
	return Boolean(entrypoint && import.meta.url === pathToFileURL(entrypoint).href);
}

if (isEntrypoint()) {
	const args = process.argv.slice(2);
	const evidencePath =
		args.find((arg) => !arg.startsWith("--"))?.trim() ||
		process.env.MAESTRO_A2A_LIVE_EVIDENCE_PATH?.trim();
	if (!evidencePath) {
		console.error(
			"Usage: tsx scripts/verify-platform-a2a-live-evidence.ts <evidence.json> [--require-signature] [--require-github-dereference] [--require-negative-auth-probe] [--require-discovery-evidence] [--require-durable-a2a-ids] [--require-realtime-delivery-evidence]",
		);
		process.exitCode = 2;
	} else {
		verifyPlatformA2ALiveEvidenceFile(evidencePath, {
			requireDereferenceableGithub:
				args.includes("--require-github-dereference") ||
				booleanEnv(
					process.env.MAESTRO_A2A_LIVE_EVIDENCE_REQUIRE_GITHUB_DEREFERENCE,
				),
			requireNegativeAuthProbe:
				args.includes("--require-negative-auth-probe") ||
				booleanEnv(
					process.env.MAESTRO_A2A_LIVE_EVIDENCE_REQUIRE_NEGATIVE_AUTH_PROBE,
				),
			requireDiscoveryEvidence:
				args.includes("--require-discovery-evidence") ||
				booleanEnv(
					process.env.MAESTRO_A2A_LIVE_EVIDENCE_REQUIRE_DISCOVERY_EVIDENCE,
				),
			requireDurableA2AIds:
				args.includes("--require-durable-a2a-ids") ||
				booleanEnv(
					process.env.MAESTRO_A2A_LIVE_EVIDENCE_REQUIRE_DURABLE_A2A_IDS,
				),
			requireRealtimeDeliveryEvidence:
				args.includes("--require-realtime-delivery-evidence") ||
				booleanEnv(
					process.env
						.MAESTRO_A2A_LIVE_EVIDENCE_REQUIRE_REALTIME_DELIVERY_EVIDENCE,
				),
			requireSignature:
				args.includes("--require-signature") ||
				booleanEnv(process.env.MAESTRO_A2A_LIVE_EVIDENCE_REQUIRE_SIGNATURE),
		})
			.then((result) => {
				console.log(JSON.stringify(result, null, 2));
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				console.error(message);
				process.exitCode = 1;
			});
	}
}
