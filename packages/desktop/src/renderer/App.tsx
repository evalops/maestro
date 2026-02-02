/**
 * Main Application Component
 *
 * Root component with premium dark theme aesthetic.
 */

import { useCallback, useEffect, useState } from "react";
import { ChatContainer } from "./components/Chat/ChatContainer";
import { Header } from "./components/Header/Header";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { useComposer } from "./hooks/useComposer";

export default function App() {
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
	const {
		sessions,
		models,
		currentModel,
		loading,
		createSession,
		deleteSession,
		setModel,
	} = useComposer();

	// Handle menu events from the native menu
	useEffect(() => {
		if (!window.electron?.onMenuEvent) return;

		const cleanup = window.electron.onMenuEvent((event, ...args) => {
			switch (event) {
				case "new-session":
					handleNewSession();
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
		}
	}, [createSession]);

	const handleSessionSelect = useCallback((sessionId: string) => {
		setCurrentSessionId(sessionId);
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
					sessions={sessions}
					currentSessionId={currentSessionId}
					onSessionSelect={handleSessionSelect}
					onSessionDelete={handleSessionDelete}
					onNewSession={handleNewSession}
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
					<ChatContainer sessionId={currentSessionId} />
				</main>
			</div>
		</div>
	);
}
