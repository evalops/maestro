import type {
	ComposerApprovalMode,
	ComposerApprovalStatusUpdate,
} from "@evalops/contracts";
import type { ApiClient, Message } from "../services/api-client.js";
import { executeWebSlashCommand } from "./composer-chat-slash-commands.js";
import type { UiMessage } from "./composer-chat-stream-state.js";
import type { WebSlashCommand } from "./slash-commands.js";

export interface ComposerChatSlashCommandContext {
	apiClient: ApiClient;
	appendLocalMessage: (message: UiMessage) => void;
	appendCommandOutput: (
		command: string,
		output: string,
		isError?: boolean,
	) => void;
	applyTheme: (theme: "dark" | "light") => void;
	applyZenMode: (enabled: boolean) => void;
	commands: WebSlashCommand[];
	commandPrefs: { favorites: string[]; recents: string[] };
	createNewSession: () => Promise<void>;
	currentSessionId: string | null;
	isSharedSession: boolean;
	openCommandDrawer: () => void;
	openModelSelector: () => void;
	saveCommandPrefs: (prefs: {
		favorites: string[];
		recents: string[];
	}) => Promise<void>;
	selectSession: (sessionId: string) => Promise<void>;
	setApprovalModeStatus: (status: ComposerApprovalStatusUpdate) => void;
	setCleanMode: (mode: "off" | "soft" | "aggressive") => void;
	setCurrentModel: (model: string) => void;
	setFooterMode: (mode: "ensemble" | "solo") => void;
	setInputValue: (text: string) => void;
	setQueueMode: (mode: "one" | "all") => void;
	setTransportPreference: (mode: "auto" | "sse" | "ws") => void;
	theme: "dark" | "light";
	updateModelMeta: () => Promise<void>;
	zenMode: boolean;
}

export function isComposerSlashCommand(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return false;
	if (trimmed.startsWith("//")) return false;
	return trimmed.length > 1;
}

export function appendComposerCommandOutput(
	appendLocalMessage: (message: UiMessage) => void,
	command: string,
	output: string,
	isError = false,
): void {
	const label = isError ? "Command failed" : "Command output";
	const content = `/${command}\n\n${output}`;
	appendLocalMessage({
		role: "assistant",
		content: content || label,
		timestamp: new Date().toISOString(),
		localOnly: true,
	});
}

export async function runComposerChatSlashCommand(
	rawText: string,
	attachments: Message["attachments"] | undefined,
	context: ComposerChatSlashCommandContext,
): Promise<void> {
	const text = rawText.trim();
	const [, ...rest] = text.split(/\s+/);
	const command = text.slice(1).split(/\s+/)[0]?.toLowerCase() ?? "";
	const args = rest.join(" ").trim();

	context.appendLocalMessage({
		role: "user",
		content: text,
		timestamp: new Date().toISOString(),
		localOnly: true,
	});

	if (command) {
		const recents = [
			command,
			...context.commandPrefs.recents.filter((name) => name !== command),
		].slice(0, 20);
		void context.saveCommandPrefs({
			favorites: context.commandPrefs.favorites,
			recents,
		});
	}

	if (attachments && attachments.length > 0) {
		context.appendCommandOutput(
			command,
			"Attachments are not supported for slash commands.",
			true,
		);
		return;
	}

	await executeWebSlashCommand(command, args, {
		apiClient: context.apiClient,
		appendCommandOutput: (output, isError = false) =>
			context.appendCommandOutput(command, output, isError),
		applyTheme: (theme) => context.applyTheme(theme),
		applyZenMode: (enabled) => context.applyZenMode(enabled),
		commands: context.commands,
		createNewSession: () => context.createNewSession(),
		currentSessionId: context.currentSessionId,
		isSharedSession: context.isSharedSession,
		openCommandDrawer: context.openCommandDrawer,
		openModelSelector: context.openModelSelector,
		selectSession: (sessionId) => context.selectSession(sessionId),
		setApprovalModeStatus: (status) => context.setApprovalModeStatus(status),
		setCleanMode: (mode) => context.setCleanMode(mode),
		setCurrentModel: (model) => context.setCurrentModel(model),
		setFooterMode: (mode) => context.setFooterMode(mode),
		setInputValue: (value) => context.setInputValue(value),
		setQueueMode: (mode) => context.setQueueMode(mode),
		setTransportPreference: (mode) => context.setTransportPreference(mode),
		theme: context.theme,
		updateModelMeta: () => context.updateModelMeta(),
		zenMode: context.zenMode,
	});
}
