/**
 * Git command parsing for URL extraction.
 *
 * Extracted from url-extractor.ts to isolate the git-command sub-domain
 * (parsing `git clone|remote|config|submodule|archive ...` invocations into
 * their network-relevant target args, and detecting local vs remote targets).
 *
 * Self-contained: depends only on its own constants + stdlib. url-extractor.ts
 * imports the entry points back. One-way runtime dependency (no cycle).
 */

const NETWORK_GIT_SUBCOMMANDS = new Set([
	"archive",
	"clone",
	"config",
	"fetch",
	"ls-remote",
	"pull",
	"push",
	"remote",
	"submodule",
]);

const GIT_NESTED_SUBCOMMAND_WRAPPERS = new Set(["lfs", "svn"]);

export const GIT_GLOBAL_FLAGS_WITH_VALUES = new Set([
	"-C",
	"-c",
	"--config-env",
	"--exec-path",
	"--git-dir",
	"--namespace",
	"--super-prefix",
	"--work-tree",
]);

export const GIT_CLONE_FLAGS_WITH_VALUES = new Set([
	"-b",
	"--branch",
	"-c",
	"--config",
	"--bundle-uri",
	"--depth",
	"--filter",
	"-j",
	"--jobs",
	"-o",
	"--origin",
	"--reference",
	"--reference-if-able",
	"--separate-git-dir",
	"--server-option",
	"--shallow-exclude",
	"--shallow-since",
	"--template",
	"-u",
	"--upload-pack",
]);

const GIT_REMOTE_ADD_FLAGS_WITH_VALUES = new Set([
	"-m",
	"--master",
	"-t",
	"--track",
]);

const GIT_CONFIG_FLAGS_WITH_VALUES = new Set([
	"-f",
	"--blob",
	"--comment",
	"--default",
	"--file",
	"--fixed-value",
	"--type",
	"--value",
]);

const GIT_REMOTE_LOCAL_ACTIONS = new Set([
	"get-url",
	"prune",
	"remove",
	"rename",
	"rm",
	"set-branches",
	"set-head",
]);

const GIT_SUBMODULE_ADD_FLAGS_WITH_VALUES = new Set([
	"-b",
	"--branch",
	"--depth",
	"--name",
	"--reference",
]);

const GIT_SUBMODULE_LOCAL_ACTIONS = new Set([
	"absorbgitdirs",
	"deinit",
	"init",
	"set-branch",
	"status",
	"summary",
	"sync",
]);

export function isLocalGitTarget(value: string): boolean {
	const target = value.trim().replace(/^["']|["']$/g, "");
	return (
		target === "." ||
		target === ".." ||
		target.startsWith("./") ||
		target.startsWith("../") ||
		target.startsWith("/") ||
		target.startsWith("~/") ||
		target.startsWith("file://")
	);
}

function gitNonFlagArgs(
	args: string[],
	flagsWithValues: Set<string>,
): string[] {
	const values: string[] = [];
	let skipNext = false;
	let optionsEnded = false;

	for (const arg of args) {
		if (skipNext) {
			skipNext = false;
			continue;
		}

		if (!optionsEnded && arg === "--") {
			optionsEnded = true;
			continue;
		}

		if (!optionsEnded && arg.startsWith("-")) {
			const [flag] = arg.split("=", 1);
			if (flag && flagsWithValues.has(flag) && !arg.includes("=")) {
				skipNext = true;
			}
			continue;
		}

		values.push(arg);
	}

	return values;
}

export function gitCloneNonFlagArgs(args: string[]): string[] {
	return gitNonFlagArgs(args, GIT_CLONE_FLAGS_WITH_VALUES);
}

export function gitRemoteTargetArgs(args: string[]): string[] {
	const targets = gitNonFlagArgs(args, GIT_REMOTE_ADD_FLAGS_WITH_VALUES);
	const action = targets[0]?.toLowerCase();
	if (action === "add") {
		return targets.slice(2, 3);
	}
	if (action === "set-url") {
		return targets.slice(2);
	}
	if (action && !GIT_REMOTE_LOCAL_ACTIONS.has(action)) {
		return targets.slice(0, 1);
	}
	return [];
}

export function gitConfigTargetArgs(args: string[]): string[] {
	const targets = gitNonFlagArgs(args, GIT_CONFIG_FLAGS_WITH_VALUES);
	const key = targets[0];
	if (!key || targets.length < 2) {
		return [];
	}

	const rewriteTarget = key.match(
		/^url\.(.+)\.(?:insteadof|pushinsteadof)$/i,
	)?.[1];
	if (rewriteTarget) {
		return [rewriteTarget];
	}

	if (
		/^remote\..+\.(?:push)?url$/i.test(key) ||
		/^submodule\..+\.url$/i.test(key)
	) {
		return targets.slice(1, 2);
	}

	return [];
}

export function gitConfigCommandIsLocal(args: string[]): boolean {
	return gitConfigTargetArgs(args).length === 0;
}

export function gitRemoteCommandIsLocal(args: string[]): boolean {
	const targets = gitNonFlagArgs(args, GIT_REMOTE_ADD_FLAGS_WITH_VALUES);
	const action = targets[0]?.toLowerCase();
	if (!action || GIT_REMOTE_LOCAL_ACTIONS.has(action)) {
		return true;
	}
	if (action === "add") {
		return targets.length < 3;
	}
	if (action === "set-url") {
		return targets.length < 3;
	}
	return false;
}

export function gitSubmoduleTargetArgs(args: string[]): string[] {
	const targets = gitNonFlagArgs(args, GIT_SUBMODULE_ADD_FLAGS_WITH_VALUES);
	const action = targets[0]?.toLowerCase();
	if (!action || GIT_SUBMODULE_LOCAL_ACTIONS.has(action)) {
		return [];
	}
	if (action === "add") {
		return targets.slice(1, 2);
	}
	return targets.slice(0, 1);
}

export function gitSubmoduleCommandIsLocal(args: string[]): boolean {
	const targets = gitNonFlagArgs(args, GIT_SUBMODULE_ADD_FLAGS_WITH_VALUES);
	const action = targets[0]?.toLowerCase();
	return !action || GIT_SUBMODULE_LOCAL_ACTIONS.has(action);
}

export function gitArchiveTargetArgs(args: string[]): string[] {
	const targets: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		if (arg === "--remote" && index + 1 < args.length) {
			targets.push(args[index + 1]!);
			index += 1;
			continue;
		}
		if (arg.startsWith("--remote=")) {
			const target = arg.slice("--remote=".length);
			if (target) {
				targets.push(target);
			}
		}
	}

	return targets;
}

function nextGitSubcommandToken(
	args: string[],
): { subcommand: string; args: string[] } | null {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		if (arg === "--") {
			continue;
		}

		const [flag] = arg.split("=", 1);
		if (
			flag &&
			GIT_GLOBAL_FLAGS_WITH_VALUES.has(flag) &&
			!arg.includes("=") &&
			index + 1 < args.length
		) {
			index += 1;
			continue;
		}
		if (arg.startsWith("-c") && arg !== "-c") {
			continue;
		}
		if (arg.startsWith("--")) {
			continue;
		}
		if (arg.startsWith("-")) {
			continue;
		}

		const subcommand = arg.toLowerCase();
		return { subcommand, args: args.slice(index + 1) };
	}

	return null;
}

export function gitSubcommandInvocation(
	args: string[],
): { subcommand: string; args: string[] } | null {
	const invocation = nextGitSubcommandToken(args);
	if (!invocation) {
		return null;
	}

	if (NETWORK_GIT_SUBCOMMANDS.has(invocation.subcommand)) {
		return invocation;
	}

	if (!GIT_NESTED_SUBCOMMAND_WRAPPERS.has(invocation.subcommand)) {
		return null;
	}

	const nestedInvocation = nextGitSubcommandToken(invocation.args);
	return nestedInvocation &&
		NETWORK_GIT_SUBCOMMANDS.has(nestedInvocation.subcommand)
		? nestedInvocation
		: null;
}
