/** Full-bleed dashboard viewer at /dashboards/:id */

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { type DashboardEntry, api } from "../api/client";
import { DashboardHeader } from "../components/dashboard/DashboardHeader";
import { DashboardRenderer } from "../components/dashboard/DashboardRenderer";
import "../components/dashboard/dashboard.css";

function hasBearerToken(): boolean {
	try {
		return !!localStorage.getItem("slack_agent_ui_token");
	} catch {
		return false;
	}
}

export function DashboardViewerPage() {
	const { teamId, id } = useParams<{ teamId: string; id: string }>();
	const navigate = useNavigate();
	const [dashboard, setDashboard] = useState<DashboardEntry | null>(null);
	const [spec, setSpec] = useState<
		import("../types/dashboard").DashboardSpec | null
	>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [theme, setTheme] = useState<"dark" | "light">("dark");
	const [canShare, setCanShare] = useState(false);
	const [shareBusy, setShareBusy] = useState(false);
	const [shareMsg, setShareMsg] = useState<string | null>(null);

	const workspace = useMemo(
		() => (teamId ? api.workspaces(teamId) : null),
		[teamId],
	);

	useEffect(() => {
		if (!teamId) return;
		api.auth
			.me()
			.then((me) => {
				const role = me.ok ? me.session?.teams?.[teamId]?.role : undefined;
				setCanShare(
					hasBearerToken() || role === "admin" || role === "power_user",
				);
			})
			.catch(() => {
				// ignore auth errors here; render endpoint will fail if unauthorized
			});
	}, [teamId]);

	useEffect(() => {
		let cancel = false;
		if (!id || !workspace) return;

		setLoading(true);
		setError(null);

		workspace.dashboards
			.get(id)
			.then(async (d) => {
				if (cancel) return;
				setDashboard(d);

				if (!d.definition && d.url && !d.spec) {
					window.location.href = d.url;
					return;
				}

				if (d.spec && !d.definition) {
					setSpec(d.spec);
					if (d.spec.theme) setTheme(d.spec.theme);
					return;
				}

				const render = await workspace.dashboards.render(id);
				if (cancel) return;
				setSpec(render.spec);
				if (render.spec?.theme) setTheme(render.spec.theme);
			})
			.catch((e) => {
				if (!cancel) setError(e instanceof Error ? e.message : String(e));
			})
			.finally(() => {
				if (!cancel) setLoading(false);
			});

		return () => {
			cancel = true;
		};
	}, [id, workspace]);

	const effectiveVisibility =
		dashboard?.visibility ??
		// Backward compat: dashboards without visibility are treated as shared by the API.
		"shared";
	const isShared = effectiveVisibility === "shared";

	// Poll on the dashboard's configured refresh interval (default: 5 minutes).
	useEffect(() => {
		if (!id || !workspace || !dashboard?.definition) return;
		const refreshMs = Math.max(
			60_000,
			dashboard.definition.refreshIntervalMs ?? 5 * 60 * 1000,
		);
		const t = window.setInterval(() => {
			workspace.dashboards
				.render(id)
				.then((r) => {
					setSpec(r.spec);
					if (r.spec?.theme) setTheme(r.spec.theme);
				})
				.catch(() => {
					// ignore; keep last rendered spec on screen
				});
		}, refreshMs);
		return () => window.clearInterval(t);
	}, [dashboard?.definition, id, workspace]);

	const copyLink = async () => {
		if (!teamId || !id) return;
		const link = `${window.location.origin}/${encodeURIComponent(teamId)}/dashboards/${encodeURIComponent(id)}`;
		try {
			await navigator.clipboard.writeText(link);
			setShareMsg("Link copied.");
		} catch {
			setShareMsg(link);
		}
		window.setTimeout(() => setShareMsg(null), 2500);
	};

	const share = async () => {
		if (!workspace || !id) return;
		setShareBusy(true);
		setShareMsg(null);
		try {
			await workspace.dashboards.share(id);
			const updated = await workspace.dashboards.get(id);
			setDashboard(updated);
			setShareMsg("Shared.");
		} catch (e) {
			setShareMsg(e instanceof Error ? e.message : String(e));
		} finally {
			setShareBusy(false);
		}
		window.setTimeout(() => setShareMsg(null), 2500);
	};

	const unshare = async () => {
		if (!workspace || !id) return;
		setShareBusy(true);
		setShareMsg(null);
		try {
			await workspace.dashboards.unshare(id);
			const updated = await workspace.dashboards.get(id);
			setDashboard(updated);
			setShareMsg("Unshared.");
		} catch (e) {
			setShareMsg(e instanceof Error ? e.message : String(e));
		} finally {
			setShareBusy(false);
		}
		window.setTimeout(() => setShareMsg(null), 2500);
	};

	if (loading) {
		return (
			<div className="dashboard" data-theme={theme}>
				<div className="dashboard-loading">
					<div className="dashboard-loading-shimmer" />
					<span>Loading dashboard...</span>
				</div>
			</div>
		);
	}

	if (!teamId) {
		return (
			<div className="dashboard" data-theme={theme}>
				<div className="dashboard-error">
					<div className="dashboard-error-icon">&#9744;</div>
					<h2>Missing workspace</h2>
					<p className="dashboard-error-message">
						This dashboard link is missing a workspace teamId.
					</p>
					<button
						type="button"
						className="dashboard-error-back"
						onClick={() => navigate("/slack")}
					>
						&larr; Back to Slack Setup
					</button>
				</div>
			</div>
		);
	}

	if (error || !dashboard || !spec) {
		return (
			<div className="dashboard" data-theme={theme}>
				<div className="dashboard-error">
					<div className="dashboard-error-icon">&#9744;</div>
					<h2>{error ? "Error loading dashboard" : "Dashboard not found"}</h2>
					<p className="dashboard-error-message">
						{error ?? "The dashboard you're looking for doesn't exist."}
					</p>
					<button
						type="button"
						className="dashboard-error-back"
						onClick={() =>
							navigate(`/${encodeURIComponent(teamId)}/dashboards`)
						}
					>
						&larr; Back to Control Panel
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="dashboard" data-theme={theme}>
			<DashboardHeader
				title={spec.title}
				subtitle={spec.subtitle}
				generatedAt={spec.generatedAt}
				theme={theme}
				backTo={`/${encodeURIComponent(teamId)}/dashboards`}
				mode={dashboard.definition ? "live" : "snapshot"}
				visibility={effectiveVisibility}
				canShare={canShare}
				shareBusy={shareBusy}
				shareMessage={shareMsg}
				onCopyLink={copyLink}
				onShare={share}
				onUnshare={unshare}
				isShared={isShared}
				onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
			/>
			<DashboardRenderer spec={spec} />
		</div>
	);
}
