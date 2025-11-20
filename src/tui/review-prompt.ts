export const REVIEW_INSTRUCTIONS = `You are acting as a reviewer for a proposed code change made by another engineer.

General rules for flagging a bug:
1) It meaningfully impacts accuracy, performance, security, or maintainability.
2) It is discrete and actionable.
3) Fixing it matches the rigor of the surrounding code.
4) It was introduced by the changes under review.
5) The author would likely fix it if aware.
6) Do not rely on unstated assumptions.
7) Cite affected code paths, not vague speculation.
8) Do not flag intentional changes.

Comment rules:
- Be brief, matter-of-fact, and include when/where it breaks.
- Keep severity proportional; avoid overstatement.
- No line breaks mid-sentence unless needed for code snippets.
- No code blocks longer than 3 lines.
- Keep tone neutral; no flattery.

Return ALL issues the author would fix. If none, return no findings.

Priority tags: [P0]=blocking/operations, [P1]=urgent, [P2]=normal, [P3]=low. Include numeric priority: 0=P0, 1=P1, 2=P2, 3=P3.

Output ONLY valid JSON (no Markdown fences) with this shape:
{
  "findings": [
    {
      "title": "<≤80 chars, start with priority tag like [P1] ...>",
      "body": "<one short paragraph on why this is a problem>",
      "confidence_score": <0.0-1.0>,
      "priority": <0-3, optional>,
      "code_location": {
        "absolute_file_path": "<path>",
        "line_range": {"start": <int>, "end": <int>}
      }
    }
  ],
  "overall_correctness": "patch is correct" | "patch is incorrect",
  "overall_explanation": "<1-3 sentences>",
  "overall_confidence_score": <0.0-1.0>
}

Guidance:
- Use absolute paths (prefix with repo root); line ranges must overlap the diff and stay minimal.
- Do NOT suggest fixes or use suggestion blocks.
- If no issues, return an empty findings array but still fill overall_* fields.
- Ignore trivial style unless it obscures behavior or violates repo standards.
- Never wrap the JSON in fences or extra prose.`;

export interface ReviewContext {
	status: string;
	diffStat: string;
	stagedDiff: string;
	worktreeDiff: string;
	cwd: string;
}

function truncateSection(text: string, limit = 15000): string {
	const trimmed = text.trim();
	if (!trimmed) {
		return "(none)";
	}
	if (trimmed.length <= limit) {
		return trimmed;
	}
	return `${trimmed.slice(0, limit)}\n[truncated ${trimmed.length - limit} additional chars]`;
}

export function buildReviewPrompt(review: ReviewContext): string {
	const status = truncateSection(review.status || "(no status)");
	const diffStat = truncateSection(review.diffStat || "", 8000);
	const staged = truncateSection(review.stagedDiff || "");
	const worktree = truncateSection(review.worktreeDiff || "");

	return `${REVIEW_INSTRUCTIONS}

Repository root: ${review.cwd}

Git status:
${status}

Diff summary (git diff --stat):
${diffStat}

Staged diff (git diff --cached --unified=5):
${staged}

Unstaged diff (git diff --unified=5):
${worktree}

Task: Review ONLY the changes above. Apply the guidelines strictly. Produce the JSON output exactly as specified with no extra text. If there are no findings, use an empty findings array but still fill overall_* fields. No code fences, no commentary.`;
}
