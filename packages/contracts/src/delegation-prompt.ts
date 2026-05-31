export interface DelegationPrompt {
	goal: string;
	context: string;
	task: string;
	evidence: string[];
	validation: string;
	stoppingCondition: string;
}

const EMPTY_FIELD_PLACEHOLDER = "Not provided.";
const EMPTY_EVIDENCE_PLACEHOLDER = "No specific evidence provided.";

function normalizeField(value: string): string {
	const trimmed = value.trim();
	return trimmed.length > 0
		? escapeDelegationHeadings(trimmed)
		: EMPTY_FIELD_PLACEHOLDER;
}

function normalizeEvidence(evidence: string[]): string[] {
	const normalized = evidence
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	return normalized.length > 0 ? normalized : [EMPTY_EVIDENCE_PLACEHOLDER];
}

function escapeDelegationHeadings(value: string): string {
	return value.replace(/^##(?=\s)/gm, "\\##");
}

function formatEvidenceItem(item: string): string {
	const escaped = escapeDelegationHeadings(item);
	const lines = escaped.split("\n");
	const [first = "", ...rest] = lines;
	return [`- ${first}`, ...rest.map((line) => `  ${line}`)].join("\n");
}

export function formatDelegation(prompt: DelegationPrompt): string {
	const evidence = normalizeEvidence(prompt.evidence)
		.map(formatEvidenceItem)
		.join("\n");

	return [
		"## Goal",
		normalizeField(prompt.goal),
		"",
		"## Context",
		normalizeField(prompt.context),
		"",
		"## Task",
		normalizeField(prompt.task),
		"",
		"## Evidence",
		evidence,
		"",
		"## Validation",
		normalizeField(prompt.validation),
		"",
		"## Stopping Condition",
		normalizeField(prompt.stoppingCondition),
	].join("\n");
}
