import {
	type TuiKeybindingShortcut,
	getTuiKeybindingLabel,
	getTuiKeybindingSequence,
	getTuiKeybindingShortcut,
	matchesTuiKeybinding,
} from "../keybindings.js";

export type QueuedFollowUpEditBinding = TuiKeybindingShortcut;

export function getQueuedFollowUpEditBinding(
	env: NodeJS.ProcessEnv = process.env,
): QueuedFollowUpEditBinding {
	return getTuiKeybindingShortcut("edit-last-follow-up", env);
}

export function getQueuedFollowUpEditBindingLabel(
	env: NodeJS.ProcessEnv = process.env,
): string {
	return getTuiKeybindingLabel("edit-last-follow-up", env);
}

export function matchesQueuedFollowUpEditBinding(
	data: string,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return matchesTuiKeybinding("edit-last-follow-up", data, env);
}

export function getQueuedFollowUpEditBindingSequence(
	env: NodeJS.ProcessEnv = process.env,
): string {
	return getTuiKeybindingSequence("edit-last-follow-up", env);
}
