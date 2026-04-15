/**
 * Main Application Component
 *
 * Root component with premium dark theme aesthetic.
 */

import { useCallback, useEffect, useState } from "react";
import { AutomationsView } from "./components/Automations/AutomationsView";
import { ChatContainer } from "./components/Chat/ChatContainer";
import { Header } from "./components/Header/Header";
import {
	type DesktopSettings,
	SettingsModal,
} from "./components/Settings/SettingsModal";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { useComposer } from "./hooks/useComposer";

const DESKTOP_SETTINGS_STORAGE_KEY = "maestro-desktop-settings";
const LEGACY_DESKTOP_SETTINGS_STORAGE_KEY = "composer-desktop-settings";

const DEFAULT_SETTINGS: DesktopSettings = {
	showTimestamps: true,
	density: "comfortable",
	thinkingLevel: "off",
};

export default function App() {
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [activeView, setActiveView] = useState<"chat" | "automations">("chat");
	const [settings, setSettings] = useState<DesktopSettings>(DEFAULT_SETTINGS);
	const {
		sessions,
		models,
		currentModel,
		loading,
		createSession,
		deleteSession,
		setModel,
	} = useComposer();
	useEffect(() => {
		try {
			const stored =
				localStorage.getItem(DESKTOP_SETTINGS_STORAGE_KEY) ??
				localStorage.getItem(LEGACY_DESKTOP_SETTINGS_STORAGE_KEY);
			if (stored) {
				const parsed = JSON.parse(stored) as DesktopSettings;
				setSettings({ ...DEFAULT_SETTINGS, ...parsed });
			}
		} catch (error) {
			console.warn("Failed to load settings:", error);
		}
	}, []);

	useEffect(() => {
		try {
			localStorage.setItem(
				DESKTOP_SETTINGS_STORAGE_KEY,
				JSON.stringify(settings),
			);
		} catch (error) {
			console.warn("Failed to persist settings:", error);
		}
	}, [settings]);

	// Handle menu events from the native menu
	useEffect(() => {
		if (!window.electron?.onMenuEvent) return;

		const cleanup = window.electron.onMenuEvent((event, ...args) => {
			switch (event) {
				case "new-session":
					handleNewSession();
					break;
				case "preferences":
					setSettingsOpen(true);
					break;
				case "toggle-sidebar":
					setSidebarOpen((prev) => !prev);
					break;
				case "select-model":
					break;
				case "set-model":
					if (args[0] && typeof args[0] === "string") {
						setModel(args[0]);
					}
					break;
				case "view-sessions":
					setSidebarOpen(true);
					setActiveView("chat");
					break;
				default:
					console.log("Unhandled menu event:", event, args);
			}
		});

		return cleanup;
	}, [setModel]);

	const handleNewSession = useCallback(async () => {
		const session = await createSession();
		if (session) {
			setCurrentSessionId(session.id);
			setActiveView("chat");
		}
	}, [createSession]);

	const handleSessionSelect = useCallback((sessionId: string) => {
		setCurrentSessionId(sessionId);
		setActiveView("chat");
	}, []);

	const handleSessionDelete = useCallback(
		async (sessionId: string) => {
			await deleteSession(sessionId);
			if (currentSessionId === sessionId) {
				setCurrentSessionId(null);
			}
		},
		[deleteSession, currentSessionId],
	);

	// Create initial session if none exists
	useEffect(() => {
		if (!loading && sessions.length === 0) {
			handleNewSession();
		} else if (!loading && sessions.length > 0 && !currentSessionId) {
			setCurrentSessionId(sessions[0].id);
		}
	}, [loading, sessions, currentSessionId, handleNewSession]);

	const handleOpenSession = useCallback((sessionId: string) => {
		setCurrentSessionId(sessionId);
		setActiveView("chat");
		setSidebarOpen(true);
	}, []);

	return (
		<div className="flex flex-col h-screen overflow-hidden bg-bg-void">
			{/* Ambient gradient overlay */}
			<div
				className="fixed inset-0 pointer-events-none"
				style={{
					background: `
						radial-gradient(ellipse 100% 60% at 50% -30%, rgba(20, 184, 166, 0.06), transparent),
						radial-gradient(ellipse 50% 50% at 0% 50%, rgba(20, 184, 166, 0.02), transparent),
						radial-gradient(ellipse 40% 40% at 100% 80%, rgba(245, 158, 11, 0.015), transparent)
					`,
				}}
			/>
			{/* Subtle noise texture for depth */}
			<div
				className="fixed inset-0 pointer-events-none opacity-[0.015]"
				style={{
					backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
				}}
			/>

			{/* Custom Titlebar */}
			<Header
				currentModel={currentModel}
				models={models}
				onModelChange={setModel}
				sidebarOpen={sidebarOpen}
				onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
			/>

			{/* Accent line under header */}
			<div className="header-line" />

			{/* Main Content */}
			<div className="flex flex-1 overflow-hidden relative">
				{/* Sidebar */}
				<Sidebar
					open={sidebarOpen}
					activeView={activeView}
					sessions={sessions}
					currentSessionId={currentSessionId}
					onSessionSelect={handleSessionSelect}
					onSessionDelete={handleSessionDelete}
					onNewSession={handleNewSession}
					onViewChange={setActiveView}
					onOpenSettings={() => setSettingsOpen(true)}
				/>

				{/* Divider with gradient */}
				{sidebarOpen && (
					<div
						className="w-px"
						style={{
							background:
								"linear-gradient(180deg, transparent 0%, var(--border-subtle) 20%, var(--border-default) 50%, var(--border-subtle) 80%, transparent 100%)",
						}}
					/>
				)}

				{/* Chat Area */}
				<main
					className="flex-1 flex flex-col overflow-hidden relative"
					style={{
						background:
							"linear-gradient(180deg, var(--bg-primary) 0%, var(--bg-void) 100%)",
					}}
				>
					{activeView === "chat" ? (
						<ChatContainer
							sessionId={currentSessionId}
							sessions={sessions}
							showTimestamps={settings.showTimestamps}
							density={settings.density}
							thinkingLevel={settings.thinkingLevel}
							onSessionSelect={handleSessionSelect}
						/>
					) : (
						<AutomationsView
							sessions={sessions}
							currentSessionId={currentSessionId}
							models={models}
							currentModel={currentModel}
							onOpenSession={handleOpenSession}
						/>
					)}
				</main>
			</div>
			<SettingsModal
				open={settingsOpen}
				settings={settings}
				onChange={setSettings}
				onClose={() => setSettingsOpen(false)}
				sessionId={currentSessionId}
				models={models}
				currentModel={currentModel}
				onModelChange={setModel}
			/>
		</div>
	);
}
