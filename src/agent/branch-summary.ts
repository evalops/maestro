export const BRANCH_SUMMARY_PROMPT = `You are summarizing a conversation branch that is being left in the session tree.

Create a concise, structured summary so the branch can be resumed later. Include:
- The goal of the branch and key decisions/approaches
- Important findings or outcomes (including notable tool results)
- Files read or modified (include absolute paths if mentioned)
- Open questions and clear next steps

Do not continue the conversation. Provide only the summary.`;

export function buildBranchSummaryPrompt(customInstructions?: string): string {
	if (customInstructions) {
		return `${BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: ${customInstructions}`;
	}
	return BRANCH_SUMMARY_PROMPT;
}
