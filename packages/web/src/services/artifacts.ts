import type { Message } from "./api-client.js";

export type ArtifactsCommand =
	| "create"
	| "update"
	| "rewrite"
	| "get"
	| "delete"
	| "logs";

export interface ArtifactsArgs {
	command?: ArtifactsCommand;
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

export function createEmptyArtifactsState(): ArtifactsState {
	return { byFilename: new Map<string, Artifact>() };
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function coerceArtifactsArgs(value: unknown): ArtifactsArgs {
	if (!value || typeof value !== "object") return {};
	const v = value as Record<string, unknown>;
	const command = asString(v.command) as ArtifactsCommand | undefined;
	return {
		command,
		filename: asString(v.filename),
		content: asString(v.content),
		old_str: asString(v.old_str),
		new_str: asString(v.new_str),
	};
}

export function applyArtifactsCommand(
	state: ArtifactsState,
	args: ArtifactsArgs,
): { state: ArtifactsState; output: string; isError: boolean } {
	const command = args.command;
	const filename = args.filename?.trim();
	if (!command) {
		return { state, output: "Error: missing command", isError: true };
	}
	if (!filename) {
		return { state, output: "Error: missing filename", isError: true };
	}

	const current = state.byFilename.get(filename);

	switch (command) {
		case "create": {
			if (current) {
				return {
					state,
					output: `Error: ${filename} already exists`,
					isError: true,
				};
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
			return {
				state: { byFilename: next },
				output: `Created ${filename}`,
				isError: false,
			};
		}

		case "rewrite": {
			if (!current) {
				return { state, output: `Error: ${filename} not found`, isError: true };
			}
			const content = args.content ?? "";
			const next = new Map(state.byFilename);
			next.set(filename, { ...current, content, updatedAt: Date.now() });
			return {
				state: { byFilename: next },
				output: `Rewrote ${filename}`,
				isError: false,
			};
		}

		case "update": {
			if (!current) {
				return { state, output: `Error: ${filename} not found`, isError: true };
			}
			const oldStr = args.old_str;
			const newStr = args.new_str;
			if (oldStr === undefined || newStr === undefined) {
				return {
					state,
					output: "Error: update requires old_str and new_str",
					isError: true,
				};
			}
			if (!current.content.includes(oldStr)) {
				return {
					state,
					output: `Error: old_str not found in ${filename}`,
					isError: true,
				};
			}
			const nextContent = current.content.replace(oldStr, newStr);
			const next = new Map(state.byFilename);
			next.set(filename, {
				...current,
				content: nextContent,
				updatedAt: Date.now(),
			});
			return {
				state: { byFilename: next },
				output: `Updated ${filename}`,
				isError: false,
			};
		}

		case "get": {
			if (!current) {
				return { state, output: `Error: ${filename} not found`, isError: true };
			}
			return { state, output: current.content, isError: false };
		}

		case "delete": {
			if (!current) {
				return { state, output: `Error: ${filename} not found`, isError: true };
			}
			const next = new Map(state.byFilename);
			next.delete(filename);
			return {
				state: { byFilename: next },
				output: `Deleted ${filename}`,
				isError: false,
			};
		}

		case "logs": {
			// Log retrieval is handled by the UI (sandbox console capture).
			return {
				state,
				output: `Logs requested for ${filename}`,
				isError: false,
			};
		}
	}
}

export function reconstructArtifactsFromMessages(
	messages: Message[],
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
			const res = applyArtifactsCommand(state, args);
			if (!res.isError) {
				state = res.state;
			}
		}
	}

	return state;
}
