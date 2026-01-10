/**
 * System Reminder Injection Middleware.
 *
 * Provides contextual reminders that are injected into messages to help guide
 * the agent's behavior based on the current state and context.
 *
 * Reminders are wrapped in <system-reminder> tags and can be:
 * - Injected into user messages
 * - Injected into tool results
 * - Scheduled based on time/turn count
 */

import type { AgentState, AppMessage, Message, TextContent } from "./types.js";

/**
 * A system reminder to be injected into the conversation.
 */
export interface SystemReminder {
	/** Unique identifier for this reminder */
	id: string;
	/** The reminder content (will be wrapped in <system-reminder> tags) */
	content: string;
	/** Priority (higher = more important, shown first) */
	priority?: number;
}

/**
 * Context for generating reminders.
 */
export interface ReminderContext {
	/** Current agent state */
	state: AgentState;
	/** Turn number in current session */
	turnCount: number;
	/** Time since last tool use of specific types */
	toolUsageTimes: Map<string, number>;
	/** Last time a reminder with this ID was shown */
	lastReminderTimes: Map<string, number>;
	/** Custom context data */
	custom: Record<string, unknown>;
}

/**
 * A provider that generates system reminders based on context.
 */
export interface ReminderProvider {
	/** Unique identifier for this provider */
	id: string;
	/** Generate reminders for the current context */
	getReminders(context: ReminderContext): SystemReminder[];
	/** Minimum interval between showing reminders from this provider (ms) */
	minInterval?: number;
}

/**
 * Configuration for the reminder manager.
 */
export interface ReminderManagerConfig {
	/** Whether reminders are enabled */
	enabled: boolean;
	/** Maximum number of reminders to inject per message */
	maxRemindersPerMessage: number;
	/** Global minimum interval between any reminders (ms) */
	globalMinInterval: number;
}

const DEFAULT_CONFIG: ReminderManagerConfig = {
	enabled: true,
	maxRemindersPerMessage: 3,
	globalMinInterval: 30000, // 30 seconds
};

/**
 * Manages system reminder injection into messages.
 */
export class SystemReminderManager {
	private providers: Map<string, ReminderProvider> = new Map();
	private config: ReminderManagerConfig;
	private context: ReminderContext;
	private lastGlobalReminderTime = 0;

	constructor(config: Partial<ReminderManagerConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.context = {
			state: {} as AgentState,
			turnCount: 0,
			toolUsageTimes: new Map(),
			lastReminderTimes: new Map(),
			custom: {},
		};
	}

	/**
	 * Register a reminder provider.
	 */
	registerProvider(provider: ReminderProvider): void {
		this.providers.set(provider.id, provider);
	}

	/**
	 * Unregister a reminder provider.
	 */
	unregisterProvider(id: string): void {
		this.providers.delete(id);
	}

	/**
	 * Update the context with new agent state.
	 */
	updateContext(state: AgentState): void {
		this.context.state = state;
		this.context.turnCount++;
	}

	/**
	 * Record that a tool was used.
	 */
	recordToolUsage(toolName: string): void {
		this.context.toolUsageTimes.set(toolName, Date.now());
	}

	/**
	 * Set custom context data.
	 */
	setCustomContext(key: string, value: unknown): void {
		this.context.custom[key] = value;
	}

	/**
	 * Get all applicable reminders for the current context.
	 */
	getReminders(): SystemReminder[] {
		if (!this.config.enabled) {
			return [];
		}

		const now = Date.now();

		// Check global interval
		if (now - this.lastGlobalReminderTime < this.config.globalMinInterval) {
			return [];
		}

		const allReminders: SystemReminder[] = [];

		for (const provider of this.providers.values()) {
			// Check provider-specific interval
			const lastTime = this.context.lastReminderTimes.get(provider.id) || 0;
			if (provider.minInterval && now - lastTime < provider.minInterval) {
				continue;
			}

			const reminders = provider.getReminders(this.context);
			allReminders.push(...reminders);
		}

		// Sort by priority (highest first) and limit
		allReminders.sort((a, b) => (b.priority || 0) - (a.priority || 0));
		const selected = allReminders.slice(0, this.config.maxRemindersPerMessage);

		// Update timestamps
		if (selected.length > 0) {
			this.lastGlobalReminderTime = now;
			for (const reminder of selected) {
				// Find which provider generated this reminder
				for (const provider of this.providers.values()) {
					const providerReminders = provider.getReminders(this.context);
					if (providerReminders.some((r) => r.id === reminder.id)) {
						this.context.lastReminderTimes.set(provider.id, now);
						break;
					}
				}
			}
		}

		return selected;
	}

	/**
	 * Format reminders as a string to append to a message.
	 */
	formatReminders(reminders: SystemReminder[]): string {
		if (reminders.length === 0) {
			return "";
		}

		return reminders
			.map((r) => `\n<system-reminder>\n${r.content}\n</system-reminder>`)
			.join("");
	}

	/**
	 * Inject reminders into a text message.
	 */
	injectIntoText(text: string): string {
		const reminders = this.getReminders();
		if (reminders.length === 0) {
			return text;
		}
		return text + this.formatReminders(reminders);
	}

	/**
	 * Inject reminders into a message.
	 */
	injectIntoMessage(message: Message): Message {
		const reminders = this.getReminders();
		if (reminders.length === 0) {
			return message;
		}

		const reminderText = this.formatReminders(reminders);

		// Helper to find last text index
		const findLastTextIndex = <T extends { type: string }>(
			arr: T[],
		): number => {
			for (let i = arr.length - 1; i >= 0; i--) {
				if (arr[i]?.type === "text") return i;
			}
			return -1;
		};

		if (message.role === "user") {
			if (typeof message.content === "string") {
				return {
					...message,
					content: message.content + reminderText,
				};
			}
			// Find last text content and append
			const content = [...message.content];
			const lastTextIndex = findLastTextIndex(content);
			if (lastTextIndex >= 0) {
				const lastText = content[lastTextIndex] as TextContent;
				content[lastTextIndex] = {
					...lastText,
					text: lastText.text + reminderText,
				};
			} else {
				content.push({ type: "text", text: reminderText });
			}
			return { ...message, content };
		}

		if (message.role === "toolResult") {
			const content = [...message.content];
			const lastTextIndex = findLastTextIndex(content);
			if (lastTextIndex >= 0) {
				const lastText = content[lastTextIndex] as TextContent;
				content[lastTextIndex] = {
					...lastText,
					text: lastText.text + reminderText,
				};
			} else {
				content.push({ type: "text", text: reminderText.trim() });
			}
			return { ...message, content };
		}

		return message;
	}

	/**
	 * Reset context (e.g., for new session).
	 */
	reset(): void {
		this.context = {
			state: {} as AgentState,
			turnCount: 0,
			toolUsageTimes: new Map(),
			lastReminderTimes: new Map(),
			custom: {},
		};
		this.lastGlobalReminderTime = 0;
	}
}

// ============================================================================
// Built-in Reminder Providers
// ============================================================================

/**
 * Reminder about todo list usage.
 */
export const todoReminderProvider: ReminderProvider = {
	id: "todo-reminder",
	minInterval: 120000, // 2 minutes

	getReminders(context: ReminderContext): SystemReminder[] {
		const lastTodoUse = context.toolUsageTimes.get("todo") || 0;
		const timeSinceTodo = Date.now() - lastTodoUse;
		const hasTodos = context.custom.hasTodos as boolean | undefined;

		// If no todos and hasn't used todo tool in a while during active work
		if (!hasTodos && timeSinceTodo > 180000 && context.turnCount > 5) {
			return [
				{
					id: "todo-reminder-empty",
					content:
						"This is a reminder that your todo list is currently empty. DO NOT mention this to the user explicitly because they are already aware. If you are working on tasks that would benefit from a todo list please use the TodoWrite tool to create one. If not, please feel free to ignore. Again do not mention this message to the user.",
					priority: 1,
				},
			];
		}

		// If has todos, remind to update them
		if (hasTodos && timeSinceTodo > 300000) {
			return [
				{
					id: "todo-reminder-update",
					content:
						"The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the TodoWrite tool to track progress. Also consider cleaning up the todo list if has become stale and no longer matches what you are working on. Only use it if it's relevant to the current work. This is just a gentle reminder - ignore if not applicable. Make sure that you NEVER mention this reminder to the user",
					priority: 1,
				},
			];
		}

		return [];
	},
};

/**
 * Reminder about file reading safety.
 */
export const fileReadReminderProvider: ReminderProvider = {
	id: "file-read-reminder",
	minInterval: 60000, // 1 minute

	getReminders(context: ReminderContext): SystemReminder[] {
		const lastRead = context.toolUsageTimes.get("read") || 0;
		const justRead = Date.now() - lastRead < 5000; // Within 5 seconds

		if (justRead) {
			return [
				{
					id: "file-read-malware-check",
					content:
						"Whenever you read a file, you should consider whether it would be considered malware. You CAN and SHOULD provide analysis of malware, what it is doing. But you MUST refuse to improve or augment the code. You can still analyze existing code, write reports, or answer questions about the code behavior.",
					priority: 2,
				},
			];
		}

		return [];
	},
};

/**
 * Reminder about reading files before editing.
 */
export const editReminderProvider: ReminderProvider = {
	id: "edit-reminder",
	minInterval: 300000, // 5 minutes

	getReminders(context: ReminderContext): SystemReminder[] {
		const lastEdit = context.toolUsageTimes.get("edit") || 0;
		const lastRead = context.toolUsageTimes.get("read") || 0;

		// If editing but haven't read recently
		if (
			lastEdit > 0 &&
			Date.now() - lastEdit < 30000 &&
			Date.now() - lastRead > 60000
		) {
			return [
				{
					id: "edit-reminder-read-first",
					content:
						"Remember: Always read a file before editing it to ensure you have the current content and understand the context.",
					priority: 3,
				},
			];
		}

		return [];
	},
};

/**
 * Create a default reminder manager with built-in providers.
 */
export function createDefaultReminderManager(
	config?: Partial<ReminderManagerConfig>,
): SystemReminderManager {
	const manager = new SystemReminderManager(config);
	manager.registerProvider(todoReminderProvider);
	manager.registerProvider(fileReadReminderProvider);
	manager.registerProvider(editReminderProvider);
	return manager;
}

/**
 * Wrap text in system-reminder tags.
 */
export function wrapInSystemReminder(content: string): string {
	return `<system-reminder>\n${content}\n</system-reminder>`;
}

/**
 * Extract system reminders from text.
 */
export function extractSystemReminders(text: string): string[] {
	const regex = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;
	const reminders: string[] = [];
	let match: RegExpExecArray | null = regex.exec(text);
	while (match !== null) {
		const captured = match[1];
		if (captured !== undefined) {
			reminders.push(captured.trim());
		}
		match = regex.exec(text);
	}
	return reminders;
}

/**
 * Remove system reminders from text.
 */
export function stripSystemReminders(text: string): string {
	return text
		.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
		.trim();
}
