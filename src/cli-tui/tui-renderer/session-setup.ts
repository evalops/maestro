import type { Container, TUI } from "@evalops/tui";
import type { Agent } from "../../agent/agent.js";
import type { SessionManager } from "../../session/manager.js";
import type { ModalManager } from "../modal-manager.js";
import type { NotificationView } from "../notification-view.js";
import type { SessionContext } from "../session/session-context.js";
import { SessionDataProvider } from "../session/session-data-provider.js";
import { SessionSummaryController } from "../session/session-summary-controller.js";
import { SessionSwitcherView } from "../session/session-switcher-view.js";
import { SessionView } from "../session/session-view.js";

export function createSessionSubsystem(params: {
	agent: Agent;
	sessionManager: SessionManager;
	chatContainer: Container;
	ui: TUI;
	modalManager: ModalManager;
	notificationView: NotificationView;
	sessionContext: SessionContext;
	applyLoadedSessionContext: () => void;
	onSessionLoaded: (sessionInfo: { id: string; messageCount: number }) => void;
}): {
	sessionDataProvider: SessionDataProvider;
	sessionSummaryController: SessionSummaryController;
	sessionView: SessionView;
	sessionSwitcherView: SessionSwitcherView;
} {
	const {
		agent,
		sessionManager,
		chatContainer,
		ui,
		modalManager,
		notificationView,
		sessionContext,
		applyLoadedSessionContext,
		onSessionLoaded,
	} = params;

	const sessionDataProvider = new SessionDataProvider(sessionManager);
	const sessionSummaryController = new SessionSummaryController({
		agent,
		sessionManager,
		sessionDataProvider,
		showInfo: (message) => notificationView.showInfo(message),
		showError: (message) => notificationView.showError(message),
	});

	const sessionSwitcherViewRef: { current?: SessionSwitcherView } = {};

	const sessionView = new SessionView({
		agent,
		sessionManager,
		chatContainer,
		ui,
		sessionDataProvider,
		openSessionSwitcher: () => sessionSwitcherViewRef.current?.show(),
		summarizeSession: (session) => sessionSummaryController.summarize(session),
		applyLoadedSessionContext,
		showInfoMessage: (message) => notificationView.showInfo(message),
		onSessionLoaded,
		sessionContext,
	});

	const sessionSwitcherView = new SessionSwitcherView({
		sessionDataProvider,
		modalManager,
		ui,
		showInfoMessage: (message) => notificationView.showInfo(message),
		loadSession: (session) => sessionView.loadSessionFromItem(session),
		summarizeSession: (session) => sessionSummaryController.summarize(session),
	});
	sessionSwitcherViewRef.current = sessionSwitcherView;

	return {
		sessionDataProvider,
		sessionSummaryController,
		sessionView,
		sessionSwitcherView,
	};
}
