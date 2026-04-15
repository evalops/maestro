import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { type DashboardEntry, api } from "../api/client";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { StatusBadge } from "../components/StatusBadge";

export function DashboardsPage() {
	const navigate = useNavigate();
	const { teamId } = useParams<{ teamId: string }>();
	const [dashboards, setDashboards] = useState<DashboardEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!teamId) return;
		api
			.workspaces(teamId)
			.dashboards.list()
			.then(setDashboards)
			.catch((e) => setError(e.message))
			.finally(() => setLoading(false));
	}, [teamId]);

	if (loading) return <LoadingShimmer />;
	if (error) return <ErrorBanner message={error} />;
	if (!teamId)
		return <ErrorBanner message="Missing workspace teamId in URL." />;

	return (
		<div style={{ animation: "fadeUp 0.4s var(--ease-out) both" }}>
			<PageHeader
				title="Dashboards"
				subtitle={`${dashboards.length} dashboard${dashboards.length !== 1 ? "s" : ""}`}
			/>
			{dashboards.length === 0 ? (
				<EmptyState
					icon="◻"
					title="No dashboards yet"
					description="Ask the agent in Slack to build BI dashboards for this workspace, and they will appear here automatically."
				/>
			) : (
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
						gap: 14,
						marginTop: 24,
					}}
				>
					{dashboards.map((d, i) => (
						<DashboardCard
							key={d.id}
							dashboard={d}
							index={i}
							onClick={() => {
								if (d.definition || d.spec) {
									navigate(`/${encodeURIComponent(teamId)}/dashboards/${d.id}`);
									return;
								}
								if (d.url) window.open(d.url, "_blank");
							}}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function DashboardCard({
	dashboard,
	index,
	onClick,
}: { dashboard: DashboardEntry; index: number; onClick: () => void }) {
	const isExpired =
		dashboard.expiresAt && new Date(dashboard.expiresAt) < new Date();
	const isLive = !!dashboard.definition;
	const hasError = !!dashboard.lastError;
	const visibility = dashboard.visibility ?? "shared";
	return (
		<div
			style={{
				animation: "fadeUp 0.4s var(--ease-out) both",
				animationDelay: `${60 + index * 40}ms`,
			}}
		>
			<Card onClick={onClick}>
				<div
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: "flex-start",
						marginBottom: 14,
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
								width: 32,
								height: 32,
								borderRadius: "var(--radius-md)",
								background: hasError
									? "var(--danger-dim)"
									: isExpired
										? "var(--danger-dim)"
										: "var(--accent-dim)",
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								fontSize: 14,
								flexShrink: 0,
							}}
						>
							{isLive ? "📊" : dashboard.spec ? "📈" : "🌐"}
						</div>
						<h3
							style={{
								fontSize: 14,
								fontWeight: 600,
								fontFamily: "var(--font-display)",
								letterSpacing: "-0.01em",
							}}
						>
							{dashboard.label}
						</h3>
					</div>
					<div style={{ display: "flex", gap: 6, alignItems: "center" }}>
						<StatusBadge
							status={hasError ? "error" : isExpired ? "expired" : "active"}
							label={
								hasError
									? "error"
									: isLive
										? "live"
										: dashboard.spec
											? "snapshot"
											: "legacy"
							}
						/>
						<StatusBadge
							status={visibility === "shared" ? "shared" : "private"}
						/>
					</div>
				</div>
				{dashboard.definition?.prompt ? (
					<p
						style={{
							fontSize: 12,
							color: "var(--text-muted)",
							fontFamily: "var(--font-mono)",
							marginBottom: 12,
							display: "-webkit-box",
							WebkitLineClamp: 2,
							WebkitBoxOrient: "vertical",
							overflow: "hidden",
							lineHeight: 1.5,
						}}
					>
						{dashboard.definition.prompt}
					</p>
				) : dashboard.directory ? (
					<p
						style={{
							fontSize: 12,
							color: "var(--text-muted)",
							fontFamily: "var(--font-mono)",
							marginBottom: 12,
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
						}}
					>
						{dashboard.directory}
					</p>
				) : null}
				<div
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						fontSize: 11,
						color: "var(--text-muted)",
						paddingTop: 12,
						borderTop: "1px solid var(--border-subtle)",
					}}
				>
					<span
						style={{
							fontFamily: "var(--font-mono)",
							background: "var(--bg-input)",
							padding: "2px 8px",
							borderRadius: "var(--radius)",
						}}
					>
						{isLive
							? dashboard.lastRenderedAt
								? `refreshed ${new Date(dashboard.lastRenderedAt).toLocaleString()}`
								: "not rendered yet"
							: dashboard.port != null
								? `:${dashboard.port}`
								: "legacy"}
					</span>
					<span>{new Date(dashboard.createdAt).toLocaleDateString()}</span>
				</div>
			</Card>
		</div>
	);
}

function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
	return (
		<div style={{ marginBottom: 4 }}>
			<h2
				style={{
					fontSize: 24,
					fontWeight: 800,
					letterSpacing: "-0.03em",
					fontFamily: "var(--font-display)",
					lineHeight: 1.2,
				}}
			>
				{title}
			</h2>
			<p
				style={{
					fontSize: 13,
					color: "var(--text-muted)",
					marginTop: 4,
					fontFamily: "var(--font-mono)",
				}}
			>
				{subtitle}
			</p>
		</div>
	);
}

function LoadingShimmer() {
	return (
		<div style={{ padding: "40px 0" }}>
			{[1, 2, 3].map((i) => (
				<div
					key={i}
					style={{
						height: 80,
						background: "var(--bg-card)",
						borderRadius: "var(--radius-xl)",
						marginBottom: 12,
						position: "relative",
						overflow: "hidden",
					}}
				>
					<div
						style={{
							position: "absolute",
							inset: 0,
							background:
								"linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.03) 50%, transparent 100%)",
							animation: "shimmer 2s ease-in-out infinite",
						}}
					/>
				</div>
			))}
		</div>
	);
}

function ErrorBanner({ message }: { message: string }) {
	return (
		<div
			style={{
				background: "var(--danger-dim)",
				border: "1px solid rgba(248,113,113,0.15)",
				borderRadius: "var(--radius-lg)",
				padding: "14px 18px",
				fontSize: 13,
				color: "var(--danger)",
				display: "flex",
				alignItems: "center",
				gap: 10,
			}}
		>
			<span style={{ fontSize: 16, opacity: 0.8 }}>&#9888;</span>
			Error loading dashboards: {message}
		</div>
	);
}
