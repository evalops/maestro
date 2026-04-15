import type { Container, TUI } from "@evalops/tui";
import { BackgroundTasksController } from "../background/background-tasks-controller.js";
import type { NotificationView } from "../notification-view.js";

export function createBackgroundTasksController(params: {
	chatContainer: Container;
	ui: TUI;
	notificationView: NotificationView;
}): BackgroundTasksController {
	const controller = new BackgroundTasksController(params);
	controller.startNotifications();
	return controller;
}
