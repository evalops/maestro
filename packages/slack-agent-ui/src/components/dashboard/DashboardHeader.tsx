/** Dashboard header with title, subtitle, timestamp, and theme toggle. */

import { useNavigate } from "react-router-dom";

interface Props {
	title: string;
	subtitle?: string;
	generatedAt?: string;
	theme: "dark" | "light";
	onToggleTheme: () => void;
	backTo?: string;
	mode?: "live" | "snapshot";
	visibility?: "private" | "shared";
	isShared?: boolean;
	canShare?: boolean;
	shareBusy?: boolean;
	shareMessage?: string | null;
	onCopyLink?: () => void;
	onShare?: () => void;
	onUnshare?: () => void;
}

export function DashboardHeader({
	title,
	subtitle,
	generatedAt,
	theme,
	onToggleTheme,
	backTo,
	mode = "live",
	visibility = "shared",
	isShared,
	canShare,
	shareBusy,
	shareMessage,
	onCopyLink,
	onShare,
	onUnshare,
}: Props) {
	const navigate = useNavigate();
	const shared = isShared ?? visibility === "shared";

	return (
		<header className="dashboard-header">
			<div className="dashboard-header-left">
				<button
					type="button"
					className="dashboard-back-btn"
					onClick={() => navigate(backTo ?? "/")}
				>
					&larr; Control Panel
				</button>
				<div>
					<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
						<h1 className="dashboard-title">{title}</h1>
						<div className="dashboard-badges">
							<span
								className={`dashboard-badge ${
									mode === "live"
										? "dashboard-badge-live"
										: "dashboard-badge-snapshot"
								}`}
							>
								{mode === "live" ? "Live" : "Snapshot"}
							</span>
							<span
								className={`dashboard-badge ${
									shared ? "dashboard-badge-shared" : "dashboard-badge-private"
								}`}
							>
								{shared ? "Shared" : "Private"}
							</span>
						</div>
					</div>
					{subtitle && <p className="dashboard-subtitle">{subtitle}</p>}
					{generatedAt && (
						<p className="dashboard-timestamp">
							Generated {new Date(generatedAt).toLocaleString()}
						</p>
					)}
				</div>
			</div>
			<div className="dashboard-header-right">
				{shareMessage ? (
					<span className="dashboard-header-msg">{shareMessage}</span>
				) : null}
				{onCopyLink && shared ? (
					<button
						type="button"
						className="dashboard-action-btn"
						onClick={onCopyLink}
					>
						Copy link
					</button>
				) : null}
				{canShare && onShare && onUnshare ? (
					shared ? (
						<button
							type="button"
							className="dashboard-action-btn"
							onClick={onUnshare}
							disabled={shareBusy}
						>
							Unshare
						</button>
					) : (
						<button
							type="button"
							className="dashboard-action-btn dashboard-action-btn-primary"
							onClick={onShare}
							disabled={shareBusy}
						>
							Share
						</button>
					)
				) : null}
				{!canShare && !shared ? (
					<span className="dashboard-header-hint">
						Ask a power user to share
					</span>
				) : null}
				<button
					type="button"
					className="dashboard-theme-toggle"
					onClick={onToggleTheme}
					title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
				>
					{theme === "dark" ? "\u2600" : "\u263E"}
				</button>
			</div>
		</header>
	);
}
