import type { Container, TUI } from "@evalops/tui";
import type { ModalManager } from "../modal-manager.js";
import type { NotificationView } from "../notification-view.js";
import type { TodoStore } from "../plan-view.js";
import { PlanView } from "../plan-view.js";
import { PlanController } from "../plan/plan-controller.js";

export function createPlanSubsystem(params: {
	filePath: string;
	chatContainer: Container;
	ui: TUI;
	modalManager: ModalManager;
	notificationView: NotificationView;
	setPlanHint: (hint: string | null) => void;
	onStoreChanged: (store: TodoStore) => void;
}): { planView: PlanView; planController: PlanController } {
	const {
		filePath,
		chatContainer,
		ui,
		modalManager,
		notificationView,
		setPlanHint,
		onStoreChanged,
	} = params;

	const planView = new PlanView({
		filePath,
		chatContainer,
		ui,
		showInfoMessage: (message) => notificationView.showInfo(message),
		setPlanHint,
		onStoreChanged,
	});
	const planController = new PlanController({
		filePath,
		planView,
		modalManager,
		ui,
		notificationView,
	});
	planView.syncHintWithStore();
	return { planView, planController };
}
