export type AdvisorEffortSize = "S" | "M" | "L" | "XL";

export interface AdvisorEffortSignal {
	size: AdvisorEffortSize;
	justification: string;
	revisitIf?: string;
}

const EFFORT_LINE =
	/^\s*Effort:\s*(S|M|L|XL)\s*(?:\(([^)]*)\)|[-:]\s*(.*)|\s*)$/gim;
const REVISIT_LINE = /^\s*Revisit-if:\s*(.+)$/gim;
const ADVISOR_EFFORT_SIZES = new Set(["S", "M", "L", "XL"]);

function normalizeAdvisorEffortSize(value: string): AdvisorEffortSize {
	const normalized = value.toUpperCase();
	if (ADVISOR_EFFORT_SIZES.has(normalized)) {
		return normalized as AdvisorEffortSize;
	}
	throw new Error(`Invalid advisor effort size: ${value}`);
}

export function parseAdvisorEffortSignal(
	output: string,
): AdvisorEffortSignal | null {
	let effortMatch: RegExpExecArray | null = null;
	for (
		let match = EFFORT_LINE.exec(output);
		match;
		match = EFFORT_LINE.exec(output)
	) {
		effortMatch = match;
	}
	EFFORT_LINE.lastIndex = 0;

	if (!effortMatch) {
		return null;
	}

	const selectedEffortEnd = effortMatch.index + effortMatch[0].length;
	const selectedEffortScope = output.slice(selectedEffortEnd);
	let revisitMatch: RegExpExecArray | null = null;
	for (
		let match = REVISIT_LINE.exec(selectedEffortScope);
		match;
		match = REVISIT_LINE.exec(selectedEffortScope)
	) {
		revisitMatch = match;
	}
	REVISIT_LINE.lastIndex = 0;

	const justification = (effortMatch[2] ?? effortMatch[3] ?? "").trim();
	const revisitIf = revisitMatch?.[1]?.trim();

	return {
		size: normalizeAdvisorEffortSize(effortMatch[1] ?? ""),
		justification,
		...(revisitIf ? { revisitIf } : {}),
	};
}
