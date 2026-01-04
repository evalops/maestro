import type { Agent } from "../../agent/agent.js";
import type { CustomEditor } from "../custom-editor.js";
import type { NotificationView } from "../notification-view.js";
import { QueueController, type QueueMode } from "../queue/index.js";
import type { UiState } from "../ui-state.js";

export function createQueueController(params: {
	agent: Agent;
	notificationView: NotificationView;
	editor: CustomEditor;
	initialSteeringMode: QueueMode;
	initialFollowUpMode: QueueMode;
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
		initialSteeringMode,
		initialFollowUpMode,
		refreshQueuePanel,
		isAgentRunning,
		refreshFooterHint,
		requestRender,
		persistUiState,
	} = params;

	return new QueueController({
		notificationView,
		editor,
		initialSteeringMode,
		initialFollowUpMode,
		callbacks: {
			onModeChange: (kind, mode) => {
				if (kind === "steering") {
					agent.setQueueMode(mode === "all" ? "all" : "one");
				}
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
