export type QueuedFollowUpEditBinding = "alt+up" | "shift+left";

const ALT_UP_SEQUENCES = new Set(["\x1b[1;3A", "\x1b\x1b[A", "\x1b\x1bOA"]);
const SHIFT_LEFT_SEQUENCES = new Set(["\x1b[1;2D"]);

export function getQueuedFollowUpEditBinding(
	env: NodeJS.ProcessEnv = process.env,
): QueuedFollowUpEditBinding {
	const termProgram = env.TERM_PROGRAM?.trim().toLowerCase();
	if (
		env.TMUX ||
		termProgram === "tmux" ||
		termProgram === "apple_terminal" ||
		termProgram === "warp" ||
		termProgram === "warpterminal" ||
		termProgram === "vscode"
	) {
		return "shift+left";
	}
	return "alt+up";
}

export function getQueuedFollowUpEditBindingLabel(
	env: NodeJS.ProcessEnv = process.env,
): string {
	return getQueuedFollowUpEditBinding(env) === "shift+left"
		? "Shift+Left"
		: "Alt+Up";
}

export function matchesQueuedFollowUpEditBinding(
	data: string,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return getQueuedFollowUpEditBinding(env) === "shift+left"
		? SHIFT_LEFT_SEQUENCES.has(data)
		: ALT_UP_SEQUENCES.has(data);
}

export function getQueuedFollowUpEditBindingSequence(
	env: NodeJS.ProcessEnv = process.env,
): string {
	return getQueuedFollowUpEditBinding(env) === "shift+left"
		? "\x1b[1;2D"
		: "\x1b[1;3A";
}
