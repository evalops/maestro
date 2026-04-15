import { type Container, Spacer, type TUI, Text } from "@evalops/tui";

import type { BackgroundTaskSettings } from "../../runtime/background-settings.js";
import {
	getBackgroundTaskSettings,
	subscribeBackgroundTaskSettings,
} from "../../runtime/background-settings.js";
import {
	type BackgroundTaskNotification,
	backgroundTaskManager,
} from "../../tools/background-tasks.js";
import {
	type BackgroundRenderContext,
	handleBackgroundCommand as runBackgroundCommand,
} from "../commands/background-handlers.js";
import type { CommandExecutionContext } from "../commands/types.js";
import type { NotificationView } from "../notification-view.js";

export interface BackgroundTasksControllerOptions {
	chatContainer: Container;
	ui: TUI;
	notificationView: NotificationView;
}

/**
 * Controller for background-tasks UI concerns:
 * - Persisted background task settings subscription
 * - Toast notifications for task restart/failure/limit events
 * - /background slash command delegation
 * - Summary counts for footer hints
 */
export class BackgroundTasksController {
	private settings: BackgroundTaskSettings = getBackgroundTaskSettings();
	private unsubscribeSettings?: () => void;
	private notificationCleanup?: () => void;

	constructor(private readonly options: BackgroundTasksControllerOptions) {
		this.unsubscribeSettings = subscribeBackgroundTaskSettings((settings) => {
			this.settings = settings;
		});
	}

	startNotifications(): void {
		if (this.notificationCleanup) return;
		const handler = (payload: BackgroundTaskNotification) => {
			if (!this.settings.notificationsEnabled) {
				return;
			}
			const tone = payload.level === "warn" ? "warn" : "info";
			const reason = payload.reason ? ` (${payload.reason})` : "";
			const command =
				payload.command.length > 40
					? `${payload.command.slice(0, 37)}…`
					: payload.command;
			this.options.notificationView.showToast(
				`Background task ${payload.taskId} ${payload.message} – ${command}${reason}`,
				tone,
			);
		};

		backgroundTaskManager.on("notification", handler);
		this.notificationCleanup = () => {
			backgroundTaskManager.off("notification", handler);
		};
	}

	stop(): void {
		this.notificationCleanup?.();
		this.notificationCleanup = undefined;
		this.unsubscribeSettings?.();
		this.unsubscribeSettings = undefined;
	}

	handleBackgroundCommand(context: CommandExecutionContext): void {
		runBackgroundCommand(this.settings, this.createRenderContext(context));
	}

	getCounts(): { running: number; failed: number } {
		const tasks = backgroundTaskManager.getTasks();
		let running = 0;
		let failed = 0;
		for (const task of tasks) {
			if (task.status === "running" || task.status === "restarting") {
				running++;
			}
			if (task.status === "failed") {
				failed++;
			}
		}
		return { running, failed };
	}

	private createRenderContext(
		context: CommandExecutionContext,
	): BackgroundRenderContext {
		return {
			argumentText: context.argumentText,
			addContent: (content: string) => {
				this.options.chatContainer.addChild(new Spacer(1));
				this.options.chatContainer.addChild(new Text(content, 1, 0));
			},
			showInfo: (message: string) => {
				this.options.notificationView.showInfo(message);
			},
			showError: (message: string) => {
				this.options.notificationView.showError(message);
			},
			renderHelp: () => {
				context.renderHelp();
			},
			requestRender: () => {
				this.options.ui.requestRender();
			},
		};
	}
}
