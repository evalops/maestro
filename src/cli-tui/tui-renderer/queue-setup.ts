import type { Agent } from "../../agent/agent.js";
import type { CustomEditor } from "../custom-editor.js";
import type { NotificationView } from "../notification-view.js";
import { QueueController, type QueueMode } from "../queue/index.js";
import type { UiState } from "../ui-state.js";

export function createQueueController(params: {
	agent: Agent;
	notificationView: NotificationView;
	editor: CustomEditor;
	initialMode: QueueMode;
	refreshQueuePanel: () => void;
	isAgentRunning: () => boolean;
	refreshFooterHint: () => void;
	requestRender: () => void;
	persistUiState: (state: UiState) => void;
}): QueueController {
	const {
		agent,
		notificationView,
		editor,
		initialMode,
		refreshQueuePanel,
		isAgentRunning,
		refreshFooterHint,
		requestRender,
		persistUiState,
	} = params;

	return new QueueController({
		notificationView,
		editor,
		initialMode,
		callbacks: {
			onModeChange: (mode) => {
				agent.setQueueMode(mode === "all" ? "all" : "one");
				refreshQueuePanel();
			},
			onQueueCountChange: () => {
				refreshQueuePanel();
			},
			isAgentRunning,
			refreshFooterHint,
			requestRender,
			persistUiState,
		},
	});
}
