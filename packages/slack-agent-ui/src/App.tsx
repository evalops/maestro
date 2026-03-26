import { useEffect, useMemo, useState } from "react";
import {
	BrowserRouter,
	NavLink,
	Navigate,
	Route,
	Routes,
	useLocation,
	useNavigate,
	useParams,
} from "react-router-dom";
import { ConnectorsPage } from "./pages/Connectors";
import { DashboardViewerPage } from "./pages/DashboardViewer";
import { DashboardsPage } from "./pages/Dashboards";
import { SlackPage } from "./pages/Slack";
import { TriggersPage } from "./pages/Triggers";

const WORKSPACE_STORAGE_KEY = "slack_agent_ui_team_id";

function getStoredWorkspace(): string | null {
	try {
		return localStorage.getItem(WORKSPACE_STORAGE_KEY);
	} catch {
		return null;
	}
}

function setStoredWorkspace(teamId: string | null): void {
	try {
		if (!teamId) localStorage.removeItem(WORKSPACE_STORAGE_KEY);
		else localStorage.setItem(WORKSPACE_STORAGE_KEY, teamId);
	} catch {
		// ignore
	}
}

export function App() {
	return (
		<BrowserRouter>
			<Routes>
				<Route path="/" element={<HomeRedirect />} />
				<Route
					path="/:teamId/dashboards/:id"
					element={<DashboardViewerPage />}
				/>
				<Route
					path="*"
					element={
						<div style={{ display: "flex", height: "100vh" }}>
							<Sidebar />
							<main
								style={{
									flex: 1,
									overflow: "auto",
									padding: "36px 44px",
									background: "var(--bg-primary)",
								}}
							>
								<Routes>
									<Route path="/slack" element={<SlackPage />} />
									<Route path="/:teamId" element={<WorkspaceRedirect />} />
									<Route
										path="/:teamId/dashboards"
										element={<DashboardsPage />}
									/>
									<Route
										path="/:teamId/connectors"
										element={<ConnectorsPage />}
									/>
									<Route path="/:teamId/triggers" element={<TriggersPage />} />
									<Route path="*" element={<Navigate to="/slack" replace />} />
								</Routes>
							</main>
						</div>
					}
				/>
			</Routes>
		</BrowserRouter>
	);
}

function HomeRedirect() {
	const teamId = getStoredWorkspace();
	if (teamId) {
		return (
			<Navigate to={`/${encodeURIComponent(teamId)}/dashboards`} replace />
		);
	}
	return <Navigate to="/slack" replace />;
}

function WorkspaceRedirect() {
	const navigate = useNavigate();
	const { teamId } = useParams<{ teamId: string }>();

	useEffect(() => {
		if (teamId) {
			setStoredWorkspace(teamId);
			navigate(`/${encodeURIComponent(teamId)}/dashboards`, { replace: true });
		}
	}, [navigate, teamId]);

	return null;
}

function Sidebar() {
	const [hoveredItem, setHoveredItem] = useState<string | null>(null);
	const location = useLocation();
	// Prefer the teamId in the URL, but fall back to the last selected workspace
	// so navigation still works while you're on the global /slack page.
	const teamId = useMemo(() => {
		const fromPath = getTeamIdFromPath(location.pathname);
		return fromPath ?? getStoredWorkspace();
	}, [location.pathname]);
	const navItems = useMemo(() => buildNav(teamId), [teamId]);

	useEffect(() => {
		if (teamId) setStoredWorkspace(teamId);
	}, [teamId]);

	return (
		<nav
			style={{
				width: 240,
				borderRight: "1px solid var(--border)",
				background: "var(--bg-secondary)",
				display: "flex",
				flexDirection: "column",
				padding: "0",
				position: "relative",
				overflow: "hidden",
			}}
		>
			{/* Subtle gradient overlay at top */}
			<div
				style={{
					position: "absolute",
					top: 0,
					left: 0,
					right: 0,
					height: 120,
					background:
						"linear-gradient(180deg, rgba(45,212,191,0.03) 0%, transparent 100%)",
					pointerEvents: "none",
				}}
			/>

			{/* Brand */}
			<div
				style={{
					padding: "28px 24px 24px",
					borderBottom: "1px solid var(--border)",
					position: "relative",
				}}
			>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 10,
					}}
				>
					<div
						style={{
							width: 28,
							height: 28,
							borderRadius: "var(--radius-md)",
							background:
								"linear-gradient(135deg, var(--accent) 0%, #0d9488 100%)",
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							fontSize: 14,
							boxShadow: "0 0 16px rgba(45,212,191,0.2)",
						}}
					>
						<span style={{ filter: "brightness(0)" }}>⚡</span>
					</div>
					<div>
						<h1
							style={{
								fontSize: 14,
								fontWeight: 700,
								fontFamily: "var(--font-display)",
								color: "var(--text-primary)",
								letterSpacing: "-0.02em",
								lineHeight: 1.2,
							}}
						>
							Slack Agent
						</h1>
						<p
							style={{
								fontSize: 11,
								color: "var(--text-muted)",
								fontFamily: "var(--font-mono)",
								letterSpacing: "0.02em",
								marginTop: 1,
							}}
						>
							control plane
						</p>
					</div>
				</div>
			</div>

			{/* Navigation */}
			<div style={{ padding: "12px 12px", flex: 1 }}>
				<p
					style={{
						fontSize: 10,
						fontWeight: 600,
						color: "var(--text-muted)",
						textTransform: "uppercase",
						letterSpacing: "0.08em",
						padding: "8px 12px 6px",
						fontFamily: "var(--font-mono)",
					}}
				>
					Navigate
				</p>
				{navItems.map((item) => (
					<NavLink
						key={item.to}
						to={item.to}
						end={item.to.endsWith("/dashboards") || item.to === "/slack"}
						onMouseEnter={() => setHoveredItem(item.to)}
						onMouseLeave={() => setHoveredItem(null)}
						style={({ isActive }) => ({
							display: "flex",
							alignItems: "center",
							gap: 10,
							padding: "10px 12px",
							marginBottom: 4,
							borderRadius: "var(--radius-lg)",
							textDecoration: "none",
							fontSize: 13,
							fontWeight: 500,
							fontFamily: "var(--font-display)",
							color: isActive ? "var(--accent)" : "var(--text-secondary)",
							background: isActive
								? "var(--accent-dim)"
								: hoveredItem === item.to
									? "var(--bg-card-hover)"
									: "transparent",
							border: isActive
								? "1px solid rgba(45,212,191,0.15)"
								: "1px solid transparent",
							transition: "all 150ms var(--ease-out)",
						})}
					>
						<span style={{ opacity: 0.9 }}>{item.icon}</span>
						{item.label}
					</NavLink>
				))}
			</div>

			{/* Footer */}
			<div
				style={{
					padding: "16px 18px",
					borderTop: "1px solid var(--border)",
					color: "var(--text-muted)",
					fontSize: 11,
					fontFamily: "var(--font-mono)",
				}}
			>
				<div style={{ opacity: 0.9 }}>Workspace:</div>
				<div style={{ marginTop: 6, color: "var(--text-secondary)" }}>
					{teamId ?? "none selected"}
				</div>
			</div>
		</nav>
	);
}

function getTeamIdFromPath(pathname: string): string | null {
	if (pathname.startsWith("/slack")) return null;
	const m = pathname.match(/^\/([^/]+)/);
	if (!m) return null;
	const id = m[1];
	return id && id !== "slack" ? id : null;
}

function buildNav(teamId: string | null) {
	const items: Array<{
		to: string;
		label: string;
		icon: JSX.Element;
	}> = [];

	if (teamId) {
		const base = `/${teamId}`;
		items.push(
			{
				to: `${base}/dashboards`,
				label: "Dashboards",
				icon: (
					<svg
						aria-hidden="true"
						width="16"
						height="16"
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<rect x="1.5" y="1.5" width="5" height="5" rx="1" />
						<rect x="9.5" y="1.5" width="5" height="5" rx="1" />
						<rect x="1.5" y="9.5" width="5" height="5" rx="1" />
						<rect x="9.5" y="9.5" width="5" height="5" rx="1" />
					</svg>
				),
			},
			{
				to: `${base}/connectors`,
				label: "Connectors",
				icon: (
					<svg
						aria-hidden="true"
						width="16"
						height="16"
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<circle cx="4" cy="8" r="2.5" />
						<circle cx="12" cy="8" r="2.5" />
						<line x1="6.5" y1="8" x2="9.5" y2="8" />
					</svg>
				),
			},
			{
				to: `${base}/triggers`,
				label: "Triggers",
				icon: (
					<svg
						aria-hidden="true"
						width="16"
						height="16"
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<polyline points="9 1.5 4 8.5 7.5 8.5 7 14.5 12 7.5 8.5 7.5 9 1.5" />
					</svg>
				),
			},
		);
	}

	items.push({
		to: "/slack",
		label: "Slack",
		icon: (
			<svg
				aria-hidden="true"
				width="16"
				height="16"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M6 2.5h2.2a1.8 1.8 0 0 1 0 3.6H6" />
				<path d="M10 13.5H7.8a1.8 1.8 0 0 1 0-3.6H10" />
				<path d="M13.5 10V7.8a1.8 1.8 0 0 0-3.6 0V10" />
				<path d="M2.5 6V8.2a1.8 1.8 0 0 0 3.6 0V6" />
			</svg>
		),
	});

	return items;
}
