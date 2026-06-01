export type ArtifactsCommand =
	| "create"
	| "update"
	| "rewrite"
	| "get"
	| "delete"
	| "logs";

export type ArtifactCommandErrorCode =
	| "artifact.command_missing"
	| "artifact.command_unknown"
	| "artifact.filename_missing"
	| "artifact.filename_invalid"
	| "artifact.exists"
	| "artifact.not_found"
	| "artifact.update_args_missing"
	| "artifact.update_empty_old_str"
	| "artifact.update_old_str_not_found";

export type ArtifactCommandSuccessCode =
	| "artifact.created"
	| "artifact.rewritten"
	| "artifact.updated"
	| "artifact.read"
	| "artifact.deleted"
	| "artifact.logs_requested";

export type ArtifactCommandResultCode =
	| ArtifactCommandErrorCode
	| ArtifactCommandSuccessCode;

export interface ArtifactsArgs {
	command?: ArtifactsCommand | string;
	filename?: string;
	content?: string;
	old_str?: string;
	new_str?: string;
}

export interface Artifact {
	filename: string;
	content: string;
	createdAt: number;
	updatedAt: number;
}

export interface ArtifactsState {
	byFilename: Map<string, Artifact>;
}

export interface ArtifactCommandResult {
	state: ArtifactsState;
	output: string;
	isError: boolean;
	code: ArtifactCommandResultCode;
	mutated: boolean;
}

export interface ArtifactReplayDiagnostic {
	code: ArtifactCommandResultCode;
	command?: string;
	filename?: string;
	isError: boolean;
	mutated: boolean;
	output: string;
}

export interface ArtifactReplayOptions {
	onDiagnostic?: (diagnostic: ArtifactReplayDiagnostic) => void;
}

export interface ArtifactReplayToolCall {
	id?: unknown;
	name?: string;
	status?: string;
	toolCallId?: unknown;
	args?: unknown;
	result?: unknown;
}

export interface ArtifactReplayMessage {
	content?: unknown;
	role?: unknown;
	tools?: ArtifactReplayToolCall[];
}

const ARTIFACT_COMMANDS = new Set<string>([
	"create",
	"update",
	"rewrite",
	"get",
	"delete",
	"logs",
]);

export function createEmptyArtifactsState(): ArtifactsState {
	return { byFilename: new Map<string, Artifact>() };
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function isValidArtifactCommand(command: unknown): command is ArtifactsCommand {
	return typeof command === "string" && ARTIFACT_COMMANDS.has(command);
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 32 || code === 127) return true;
	}
	return false;
}

export function isValidArtifactFilename(filename: string): boolean {
	return (
		filename.length > 0 &&
		!filename.includes("..") &&
		!filename.includes("/") &&
		!filename.includes("\\") &&
		!hasControlCharacter(filename)
	);
}

export function coerceArtifactsArgs(value: unknown): ArtifactsArgs {
	if (!value || typeof value !== "object") return {};
	const v = value as Record<string, unknown>;
	return {
		command: asString(v.command),
		filename: asString(v.filename),
		content: asString(v.content),
		old_str: asString(v.old_str),
		new_str: asString(v.new_str),
	};
}

function artifactError(
	state: ArtifactsState,
	code: ArtifactCommandErrorCode,
	message: string,
): ArtifactCommandResult {
	return {
		state,
		output: `Error [${code}]: ${message}`,
		isError: true,
		code,
		mutated: false,
	};
}

function artifactSuccess(
	state: ArtifactsState,
	code: ArtifactCommandSuccessCode,
	output: string,
	mutated: boolean,
): ArtifactCommandResult {
	return {
		state,
		output,
		isError: false,
		code,
		mutated,
	};
}

export function applyArtifactsCommand(
	state: ArtifactsState,
	args: ArtifactsArgs,
): ArtifactCommandResult {
	const command = args.command;
	const filename = args.filename?.trim();
	if (!command) {
		return artifactError(state, "artifact.command_missing", "missing command");
	}
	if (!isValidArtifactCommand(command)) {
		return artifactError(
			state,
			"artifact.command_unknown",
			`unknown command: ${command}`,
		);
	}
	if (!filename) {
		return artifactError(
			state,
			"artifact.filename_missing",
			"missing filename",
		);
	}
	if (!isValidArtifactFilename(filename)) {
		return artifactError(
			state,
			"artifact.filename_invalid",
			"invalid filename",
		);
	}

	const current = state.byFilename.get(filename);

	switch (command) {
		case "create": {
			if (current) {
				return artifactError(
					state,
					"artifact.exists",
					`${filename} already exists`,
				);
			}
			const content = args.content ?? "";
			const now = Date.now();
			const next = new Map(state.byFilename);
			next.set(filename, {
				filename,
				content,
				createdAt: now,
				updatedAt: now,
			});
			return artifactSuccess(
				{ byFilename: next },
				"artifact.created",
				`Created ${filename}`,
				true,
			);
		}

		case "rewrite": {
			if (!current) {
				return artifactError(
					state,
					"artifact.not_found",
					`${filename} not found`,
				);
			}
			const content = args.content ?? "";
			const next = new Map(state.byFilename);
			next.set(filename, { ...current, content, updatedAt: Date.now() });
			return artifactSuccess(
				{ byFilename: next },
				"artifact.rewritten",
				`Rewrote ${filename}`,
				true,
			);
		}

		case "update": {
			if (!current) {
				return artifactError(
					state,
					"artifact.not_found",
					`${filename} not found`,
				);
			}
			const oldStr = args.old_str;
			const newStr = args.new_str;
			if (oldStr === undefined || newStr === undefined) {
				return artifactError(
					state,
					"artifact.update_args_missing",
					"update requires old_str and new_str",
				);
			}
			if (oldStr.length === 0) {
				return artifactError(
					state,
					"artifact.update_empty_old_str",
					"update requires non-empty old_str",
				);
			}
			if (!current.content.includes(oldStr)) {
				return artifactError(
					state,
					"artifact.update_old_str_not_found",
					`old_str not found in ${filename}`,
				);
			}
			const nextContent = current.content.replace(oldStr, newStr);
			const next = new Map(state.byFilename);
			next.set(filename, {
				...current,
				content: nextContent,
				updatedAt: Date.now(),
			});
			return artifactSuccess(
				{ byFilename: next },
				"artifact.updated",
				`Updated ${filename}`,
				true,
			);
		}

		case "get": {
			if (!current) {
				return artifactError(
					state,
					"artifact.not_found",
					`${filename} not found`,
				);
			}
			return artifactSuccess(state, "artifact.read", current.content, false);
		}

		case "delete": {
			if (!current) {
				return artifactError(
					state,
					"artifact.not_found",
					`${filename} not found`,
				);
			}
			const next = new Map(state.byFilename);
			next.delete(filename);
			return artifactSuccess(
				{ byFilename: next },
				"artifact.deleted",
				`Deleted ${filename}`,
				true,
			);
		}

		case "logs": {
			if (!current) {
				return artifactError(
					state,
					"artifact.not_found",
					`${filename} not found`,
				);
			}
			return artifactSuccess(
				state,
				"artifact.logs_requested",
				`Logs requested for ${filename}`,
				false,
			);
		}
	}
}

export function artifactContentsByFilename(
	state: ArtifactsState,
): Map<string, string> {
	return new Map(
		Array.from(state.byFilename.entries(), ([filename, artifact]) => [
			filename,
			artifact.content,
		]),
	);
}

export function reconstructArtifactsFromMessages(
	messages: ArtifactReplayMessage[],
	options: ArtifactReplayOptions = {},
): ArtifactsState {
	let state = createEmptyArtifactsState();

	for (const msg of messages) {
		const toolCalls = msg.tools ?? [];
		for (const tool of toolCalls) {
			if (tool.name !== "artifacts") continue;
			if (tool.status !== "completed") continue;
			if (tool.result && typeof tool.result === "object") {
				const maybeErr = tool.result as { isError?: boolean };
				if (maybeErr.isError) continue;
			}
			const args = coerceArtifactsArgs(tool.args);
			// Ignore get/logs for reconstruction; they don't change state.
			if (args.command === "get" || args.command === "logs") continue;
			const result = applyArtifactsCommand(state, args);
			if (result.isError || !result.mutated) {
				options.onDiagnostic?.({
					code: result.code,
					command: args.command,
					filename: args.filename,
					isError: result.isError,
					mutated: result.mutated,
					output: result.output,
				});
				continue;
			}
			state = result.state;
		}
	}

	return state;
}
