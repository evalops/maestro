import type {
	OperatingPlaneEvidence,
	OperatingPlaneInspection,
	OperatingPlaneRun,
	OperatingPlaneUsage,
} from "./operating-plane-client.js";

export interface OperatingPlaneStatusReport {
	contractVersion: string;
	generatedAt: string;
	runCount: number;
	unavailableSources: string[];
	runs: OperatingPlaneRunStatus[];
}

export interface OperatingPlaneRunStatus {
	runId: string;
	title: string;
	status: string;
	surface: string;
	channelThreadId?: string;
	traceId?: string;
	identitySubject?: string;
	operatorSummary?: string;
	proofPresent: string[];
	proofMissing: string[];
	evidenceRefs: OperatingPlaneEvidenceStatus[];
	nextActions: string[];
	blockers: string[];
	withheld: string[];
	usage: OperatingPlaneUsageStatus;
}

export interface OperatingPlaneEvidenceStatus {
	id: string;
	source: string;
	kind: string;
	uri?: string;
	revision?: string;
	available: boolean;
}

export interface OperatingPlaneUsageStatus {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	estimatedCostMicros?: number;
	currency?: string;
}

interface OperatingPlaneSummaryOptions {
	maxRuns?: number;
}

type ProofField = {
	label: string;
	value: boolean | undefined;
};

export function summarizeOperatingPlaneInspection(
	inspection: OperatingPlaneInspection,
	options: OperatingPlaneSummaryOptions = {},
): OperatingPlaneStatusReport {
	const maxRuns = normalizePositiveLimit(options.maxRuns);
	const runs = maxRuns ? inspection.runs.slice(0, maxRuns) : inspection.runs;

	return {
		contractVersion: inspection.contract_version,
		generatedAt: inspection.generated_at,
		runCount: inspection.runs.length,
		unavailableSources: uniqueStrings(inspection.unavailable_sources),
		runs: runs.map(summarizeOperatingPlaneRun),
	};
}

export function formatOperatingPlaneStatusReport(
	report: OperatingPlaneStatusReport,
): string {
	const lines = [
		`Agent operating-plane value proof (${report.runCount} ${pluralize("run", report.runCount)})`,
		`Generated: ${report.generatedAt}`,
	];
	if (report.unavailableSources.length > 0) {
		lines.push(`Unavailable sources: ${report.unavailableSources.join(", ")}`);
	}
	if (report.runs.length === 0) {
		lines.push("No operating-plane runs matched the query.");
		return lines.join("\n");
	}

	for (const run of report.runs) {
		lines.push(
			`- ${run.title || run.runId} [${run.status || "unknown"}] on ${run.surface || "unknown"} (${run.runId})`,
		);
		pushLine(lines, "  Summary", run.operatorSummary);
		pushLine(lines, "  Thread", run.channelThreadId);
		pushLine(lines, "  Trace", run.traceId);
		pushLine(lines, "  Identity", run.identitySubject);
		if (run.proofPresent.length > 0) {
			lines.push(`  Proof present: ${run.proofPresent.join(", ")}`);
		}
		if (run.proofMissing.length > 0) {
			lines.push(`  Missing proof: ${run.proofMissing.join(", ")}`);
		}
		if (run.evidenceRefs.length > 0) {
			lines.push(
				`  Evidence: ${run.evidenceRefs.map(formatEvidenceRef).join("; ")}`,
			);
		}
		for (const nextAction of run.nextActions) {
			lines.push(`  Next action: ${nextAction}`);
		}
		for (const blocker of run.blockers) {
			lines.push(`  Blocker: ${blocker}`);
		}
		if (run.withheld.length > 0) {
			lines.push(`  Withheld/out of scope: ${run.withheld.join(", ")}`);
		}
		const usage = formatUsage(run.usage);
		if (usage) {
			lines.push(`  Usage: ${usage}`);
		}
	}

	return lines.join("\n");
}

function summarizeOperatingPlaneRun(
	run: OperatingPlaneRun,
): OperatingPlaneRunStatus {
	const { proofPresent, proofMissing } = summarizeProof(run);
	return stripUndefined({
		runId: run.agent_run_id,
		title: oneLine(run.title) ?? "",
		status: oneLine(run.status) ?? "",
		surface: oneLine(run.surface) ?? "",
		channelThreadId: oneLine(run.channel_thread_id),
		traceId: oneLine(run.trace_id),
		identitySubject: operatingPlaneIdentitySubject(run),
		operatorSummary: oneLine(run.value_proof?.operator_summary),
		proofPresent,
		proofMissing,
		evidenceRefs: summarizeEvidenceRefs(run.evidence_refs),
		nextActions: uniqueStrings(
			run.work_items?.map((item) => oneLine(item.next_action)),
		),
		blockers: uniqueStrings(
			run.work_items?.map((item) => oneLine(item.blocker)),
		),
		withheld: operatingPlaneWithheldReasons(run),
		usage: summarizeUsage(run.usage),
	});
}

function summarizeProof(run: OperatingPlaneRun): {
	proofPresent: string[];
	proofMissing: string[];
} {
	const proof = run.value_proof;
	const fields: ProofField[] = [
		{ label: "identity", value: proof?.identity_bound },
		{ label: "model", value: proof?.model_observed },
		{ label: "tool", value: proof?.tool_observed },
		{ label: "approval", value: proof?.approval_observed },
		{ label: "trace", value: proof?.trace_linked },
		{ label: "evidence", value: proof?.evidence_linked },
		{ label: "cost", value: proof?.cost_attributed },
	];
	const proofPresent = fields
		.filter((field) => field.value === true)
		.map((field) => field.label);
	const proofMissing = uniqueStrings([
		...fields
			.filter((field) => field.value !== true)
			.map((field) => field.label),
		...(proof?.missing_proof ?? []),
		proof ? undefined : "value_proof unavailable",
	]);
	return { proofPresent, proofMissing };
}

function summarizeEvidenceRefs(
	evidenceRefs: OperatingPlaneEvidence[] | undefined,
): OperatingPlaneEvidenceStatus[] {
	return (evidenceRefs ?? [])
		.map((evidence) =>
			stripUndefined({
				id: oneLine(evidence.id) ?? "",
				source: oneLine(evidence.source) ?? "",
				kind: oneLine(evidence.kind) ?? "",
				uri: oneLine(evidence.uri),
				revision: oneLine(evidence.revision),
				available: evidence.available,
			}),
		)
		.filter((evidence) => Boolean(evidence.id));
}

function summarizeUsage(
	usage: OperatingPlaneUsage | undefined,
): OperatingPlaneUsageStatus {
	return stripUndefined({
		inputTokens: usage?.input_tokens,
		outputTokens: usage?.output_tokens,
		totalTokens: usage?.total_tokens,
		estimatedCostMicros: usage?.estimated_cost_micros,
		currency: oneLine(usage?.currency),
	});
}

function operatingPlaneIdentitySubject(
	run: OperatingPlaneRun,
): string | undefined {
	const identity = run.identity;
	return firstString([
		identity?.gateway_authenticated_subject,
		identity?.gateway_authenticated_user_subject,
		identity?.gateway_authenticated_service,
		identity?.principal_id,
		identity?.actor_id,
		identity?.agent_id,
	]);
}

function operatingPlaneWithheldReasons(run: OperatingPlaneRun): string[] {
	return uniqueStrings([
		...(run.withholding_reasons ?? []),
		run.redaction_count && run.redaction_count > 0
			? `${run.redaction_count} ${pluralize("redaction", run.redaction_count)}`
			: undefined,
		...(run.unavailable_sources ?? []),
	]);
}

function formatEvidenceRef(evidence: OperatingPlaneEvidenceStatus): string {
	const details = [
		`${evidence.source}/${evidence.kind}`,
		evidence.available ? "available" : "unavailable",
		evidence.uri ? `uri ${evidence.uri}` : undefined,
		evidence.revision ? `revision ${evidence.revision}` : undefined,
	];
	return `${evidence.id} (${uniqueStrings(details).join(", ")})`;
}

function formatUsage(usage: OperatingPlaneUsageStatus): string | undefined {
	const parts = [
		typeof usage.totalTokens === "number"
			? `${usage.totalTokens} total tokens`
			: undefined,
		typeof usage.inputTokens === "number"
			? `${usage.inputTokens} input tokens`
			: undefined,
		typeof usage.outputTokens === "number"
			? `${usage.outputTokens} output tokens`
			: undefined,
		typeof usage.estimatedCostMicros === "number"
			? `${usage.estimatedCostMicros} cost micros`
			: undefined,
		usage.currency,
	];
	return uniqueStrings(parts).join(", ") || undefined;
}

function firstString(values: Array<string | undefined>): string | undefined {
	for (const value of values) {
		const normalized = oneLine(value);
		if (normalized) {
			return normalized;
		}
	}
	return undefined;
}

function oneLine(value: string | undefined): string | undefined {
	const normalized = value?.replace(/\s+/gu, " ").trim();
	return normalized || undefined;
}

function pushLine(
	lines: string[],
	label: string,
	value: string | undefined,
): void {
	if (value) {
		lines.push(`${label}: ${value}`);
	}
}

function uniqueStrings(
	values: Array<string | undefined> | undefined,
): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const value of values ?? []) {
		const clean = oneLine(value);
		if (!clean || seen.has(clean)) {
			continue;
		}
		seen.add(clean);
		normalized.push(clean);
	}
	return normalized;
}

function pluralize(noun: string, count: number): string {
	return count === 1 ? noun : `${noun}s`;
}

function normalizePositiveLimit(value: number | undefined): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return undefined;
	}
	return Math.trunc(value);
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined),
	) as T;
}
