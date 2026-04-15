import type { TUI } from "@evalops/tui";
import type { CommandExecutionContext } from "../commands/types.js";
import type { ModalManager } from "../modal-manager.js";
import type { NotificationView } from "../notification-view.js";
import { PlanPanelModal } from "../plan-panel-modal.js";
import { type PlanView, type TodoStore, loadTodoStore } from "../plan-view.js";

export interface PlanControllerOptions {
	filePath: string;
	planView: PlanView;
	modalManager: ModalManager;
	ui: TUI;
	notificationView: NotificationView;
}

/**
 * UI controller for the /plan slash command and PlanPanelModal lifecycle.
 *
 * Keeps modal selection/mutation wiring out of TuiRenderer.
 */
export class PlanController {
	private readonly modal: PlanPanelModal;

	constructor(private readonly options: PlanControllerOptions) {
		this.modal = new PlanPanelModal({
			onClose: () => {
				this.options.modalManager.pop();
			},
			onNavigate: (delta) => {
				this.modal.navigateTasks(delta);
				this.options.ui.requestRender();
			},
			onToggleComplete: () => {
				this.toggleSelectedTaskCompletion();
			},
			onMoveTask: (direction) => {
				this.moveSelectedTask(direction);
			},
		});
	}

	handlePlanCommand(context: CommandExecutionContext): void {
		const args = context.argumentText.trim();
		if (!args || args === "list") {
			this.showPanel();
			return;
		}
		this.options.planView.handlePlanCommand(context.rawInput);
	}

	showPanel(): void {
		const store = loadTodoStore(this.options.filePath);
		this.modal.setData(store);
		this.options.modalManager.push(this.modal);
	}

	handleStoreChanged(store: TodoStore): void {
		this.modal.setData(store);
		if (this.options.modalManager.getActiveModal() === this.modal) {
			this.options.ui.requestRender();
		}
	}

	private toggleSelectedTaskCompletion(): void {
		const selectedGoal = this.modal.getSelectedGoal();
		const selectedTask = this.modal.getSelectedTask();
		if (!selectedGoal || !selectedTask) {
			this.options.notificationView.showInfo("Select a task to toggle.");
			return;
		}
		this.options.planView.toggleTaskCompletion(
			selectedGoal.key,
			selectedTask.id,
		);
	}

	private moveSelectedTask(direction: "up" | "down"): void {
		const selectedGoal = this.modal.getSelectedGoal();
		const selectedTask = this.modal.getSelectedTask();
		if (!selectedGoal || !selectedTask) {
			return;
		}
		this.options.planView.moveTask(
			selectedGoal.key,
			selectedTask.id,
			direction,
		);
		const delta = direction === "up" ? -1 : 1;
		this.modal.navigateTasks(delta);
	}
}
