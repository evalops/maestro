import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
	type SlackConfig,
	type SlackWorkspace,
	type UiSession,
	api,
	setAuthToken,
} from "../api/client";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { StatusBadge } from "../components/StatusBadge";

function useQueryParams() {
	const location = useLocation();
	return useMemo(() => new URLSearchParams(location.search), [location.search]);
}

const TOKEN_STORAGE_KEY = "slack_agent_ui_token";

function getStoredToken(): string {
	try {
		return localStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
	} catch {
		return "";
	}
}

export function SlackPage() {
	const query = useQueryParams();
	const navigate = useNavigate();
	const [config, setConfig] = useState<SlackConfig | null>(null);
	const [workspaces, setWorkspaces] = useState<SlackWorkspace[]>([]);
	const [session, setSession] = useState<UiSession | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [tokenDraft, setTokenDraft] = useState(getStoredToken());
	const [loginTeamId, setLoginTeamId] = useState("");
	const [loginUserId, setLoginUserId] = useState("");
	const [loginCode, setLoginCode] = useState("");
	const [loginBusy, setLoginBusy] = useState(false);
	const [loginMsg, setLoginMsg] = useState<string | null>(null);
	const [loginErr, setLoginErr] = useState<string | null>(null);

	const refresh = useCallback(() => {
		setError(null);
		setLoading(true);
		Promise.all([
			api.slack.config(),
			api.slack.workspaces.list(),
			api.auth.me(),
		])
			.then(([cfg, ws, me]) => {
				setConfig(cfg);
				setWorkspaces(ws);
				setSession(me.ok ? (me.session ?? null) : null);
				if (!loginTeamId) {
					const suggested =
						ws.find((w) => w.status === "active")?.teamId ?? ws[0]?.teamId;
					if (suggested) setLoginTeamId(suggested);
				}
			})
			.catch((e) => setError(e instanceof Error ? e.message : String(e)))
			.finally(() => setLoading(false));
	}, [loginTeamId]);

	useEffect(() => {
		const installed = query.get("installed");
		const installedTeamId = query.get("teamId");
		const oauthError = query.get("error");
		if (installed) {
			setNotice("Slack workspace installed successfully.");
			if (installedTeamId) setLoginTeamId(installedTeamId);
		} else if (oauthError) {
			setNotice(`Slack install error: ${oauthError}`);
		} else {
			setNotice(null);
		}
	}, [query]);

	useEffect(() => {
		refresh();
	}, [refresh]);

	const installDisabled = !config?.oauthEnabled;
	const installHint = !config
		? ""
		: config.oauthEnabled
			? `Redirect URI configured: ${config.redirectUri}`
			: "Slack OAuth not configured. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET.";
	const canManage = tokenDraft.trim().length > 0;
	const signedTeams = session ? Object.keys(session.teams) : [];

	const requestCode = async () => {
		if (!loginTeamId.trim() || !loginUserId.trim()) return;
		setLoginBusy(true);
		setLoginErr(null);
		setLoginMsg(null);
		try {
			await api.auth.requestCode(loginTeamId.trim(), loginUserId.trim());
			setLoginMsg("Login code sent via Slack DM.");
		} catch (e) {
			setLoginErr(e instanceof Error ? e.message : String(e));
		} finally {
			setLoginBusy(false);
		}
	};

	const verifyCode = async () => {
		if (!loginTeamId.trim() || !loginUserId.trim() || !loginCode.trim()) return;
		setLoginBusy(true);
		setLoginErr(null);
		setLoginMsg(null);
		try {
			const res = await api.auth.verifyCode(
				loginTeamId.trim(),
				loginUserId.trim(),
				loginCode.trim(),
			);
			if (res.ok && res.session) {
				setSession(res.session);
				setLoginMsg("Signed in.");
				setLoginCode("");
				navigate(`/${encodeURIComponent(loginTeamId.trim())}/dashboards`);
			} else {
				setLoginErr("Failed to sign in.");
			}
		} catch (e) {
			setLoginErr(e instanceof Error ? e.message : String(e));
		} finally {
			setLoginBusy(false);
		}
	};

	const logout = async () => {
		setLoginBusy(true);
		setLoginErr(null);
		setLoginMsg(null);
		try {
			await api.auth.logout();
			setSession(null);
			setLoginMsg("Signed out.");
		} catch (e) {
			setLoginErr(e instanceof Error ? e.message : String(e));
		} finally {
			setLoginBusy(false);
		}
	};

	return (
		<div style={{ animation: "fadeUp 0.4s var(--ease-out) both" }}>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "flex-start",
					marginBottom: 24,
					gap: 16,
					flexWrap: "wrap",
				}}
			>
				<div>
					<h2 style={headerStyle}>Slack</h2>
					<p style={subtitleStyle}>Install and manage workspaces</p>
				</div>
				{config?.oauthEnabled ? (
					<button
						type="button"
						onClick={() => {
							window.location.href = config.installPath;
						}}
						disabled={installDisabled}
						style={{
							...btnPrimaryStyle,
							opacity: installDisabled ? 0.5 : 1,
						}}
					>
						Install to Slack
					</button>
				) : null}
			</div>

			{notice ? (
				<div style={noticeStyle}>
					<span style={{ fontFamily: "var(--font-mono)" }}>{notice}</span>
				</div>
			) : null}

			{error ? (
				<div style={errorStyle}>
					<span style={{ fontSize: 16, opacity: 0.8 }}>&#9888;</span>
					{error}
				</div>
			) : null}

			<Card style={{ marginBottom: 14 }}>
				<div
					style={{ display: "flex", justifyContent: "space-between", gap: 16 }}
				>
					<div style={{ flex: 1, minWidth: 260 }}>
						<p style={cardTitleStyle}>UI Auth Token</p>
						<p style={cardHintStyle}>
							If SLACK_AGENT_UI_TOKEN is set on the server, enter it here so the
							UI can call the API.
						</p>
						<div
							style={{
								display: "flex",
								gap: 8,
								flexWrap: "wrap",
								marginTop: 12,
							}}
						>
							<input
								type="password"
								value={tokenDraft}
								onChange={(e) => setTokenDraft(e.target.value)}
								placeholder="Bearer token"
								style={{ ...inputStyle, minWidth: 260, flex: 1 }}
							/>
							<button
								type="button"
								onClick={() => {
									const raw = tokenDraft.trim();
									const cleaned = raw.toLowerCase().startsWith("bearer ")
										? raw.slice("bearer ".length).trim()
										: raw;
									setTokenDraft(cleaned);
									setAuthToken(cleaned);
									refresh();
								}}
								style={btnSecondaryStyle}
							>
								Save
							</button>
							<button
								type="button"
								onClick={() => {
									setTokenDraft("");
									setAuthToken("");
									refresh();
								}}
								style={btnGhostStyle}
							>
								Clear
							</button>
						</div>
					</div>
					<div style={{ flexShrink: 0, alignSelf: "flex-start" }}>
						<StatusBadge
							status={tokenDraft.trim() ? "active" : "disabled"}
							label={tokenDraft.trim() ? "configured" : "not set"}
						/>
					</div>
				</div>
			</Card>

			<Card style={{ marginBottom: 14, borderColor: "var(--border-accent)" }}>
				<p style={cardTitleStyle}>Slack App Installation</p>
				<p style={cardHintStyle}>{installHint}</p>

				{config?.oauthEnabled ? (
					<div style={{ marginTop: 12 }}>
						<div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
							<div style={{ flex: 1, minWidth: 260 }}>
								<div style={labelStyle}>Redirect URI</div>
								<code style={codeBlockStyle}>{config.redirectUri}</code>
							</div>
							<div style={{ flex: 1, minWidth: 260 }}>
								<div style={labelStyle}>Scopes</div>
								<code style={codeBlockStyle}>{config.scopes.join(", ")}</code>
							</div>
						</div>
						<div
							style={{
								display: "flex",
								gap: 8,
								marginTop: 12,
								flexWrap: "wrap",
							}}
						>
							<button
								type="button"
								onClick={() => {
									window.location.href = config.installPath;
								}}
								style={btnPrimaryStyle}
							>
								Install to Slack
							</button>
							<button
								type="button"
								onClick={refresh}
								disabled={loading}
								style={{
									...btnSecondaryStyle,
									opacity: loading ? 0.6 : 1,
								}}
							>
								Refresh
							</button>
						</div>
					</div>
				) : (
					<div
						style={{ marginTop: 12, color: "var(--text-muted)", fontSize: 12 }}
					>
						<p style={{ fontFamily: "var(--font-mono)", marginBottom: 6 }}>
							Required env vars:
						</p>
						<code style={codeBlockStyle}>
							SLACK_CLIENT_ID, SLACK_CLIENT_SECRET
						</code>
					</div>
				)}
			</Card>

			<Card style={{ marginBottom: 14 }}>
				<div
					style={{ display: "flex", justifyContent: "space-between", gap: 16 }}
				>
					<div style={{ flex: 1, minWidth: 260 }}>
						<p style={cardTitleStyle}>Sign In (Per-User)</p>
						<p style={cardHintStyle}>
							Request a one-time code and verify it. The bot will DM you a login
							code in Slack.
						</p>

						<div
							style={{
								display: "flex",
								gap: 12,
								flexWrap: "wrap",
								marginTop: 12,
							}}
						>
							<label style={{ ...labelStyle, minWidth: 240 }}>
								Workspace
								<select
									value={loginTeamId}
									onChange={(e) => setLoginTeamId(e.target.value)}
									style={inputStyle}
								>
									<option value="">Select workspace</option>
									{workspaces.map((ws) => (
										<option key={ws.teamId} value={ws.teamId}>
											{ws.teamName} ({ws.teamId})
										</option>
									))}
								</select>
							</label>

							<label style={{ ...labelStyle, minWidth: 240, flex: 1 }}>
								Slack User ID
								<input
									value={loginUserId}
									onChange={(e) => setLoginUserId(e.target.value)}
									placeholder="U012ABCDEF"
									style={inputStyle}
								/>
							</label>

							<label style={{ ...labelStyle, minWidth: 160 }}>
								Code
								<input
									value={loginCode}
									onChange={(e) => setLoginCode(e.target.value)}
									placeholder="123456"
									inputMode="numeric"
									style={inputStyle}
								/>
							</label>
						</div>

						<div
							style={{
								display: "flex",
								gap: 8,
								marginTop: 12,
								flexWrap: "wrap",
							}}
						>
							<button
								type="button"
								onClick={requestCode}
								disabled={
									loginBusy || !loginTeamId.trim() || !loginUserId.trim()
								}
								style={{
									...btnSecondaryStyle,
									opacity:
										loginBusy || !loginTeamId.trim() || !loginUserId.trim()
											? 0.6
											: 1,
								}}
							>
								Send Code
							</button>
							<button
								type="button"
								onClick={verifyCode}
								disabled={
									loginBusy ||
									!loginTeamId.trim() ||
									!loginUserId.trim() ||
									!loginCode.trim()
								}
								style={{
									...btnPrimaryStyle,
									opacity:
										loginBusy ||
										!loginTeamId.trim() ||
										!loginUserId.trim() ||
										!loginCode.trim()
											? 0.6
											: 1,
								}}
							>
								Verify
							</button>
							{session ? (
								<button
									type="button"
									onClick={logout}
									disabled={loginBusy}
									style={{
										...btnGhostStyle,
										opacity: loginBusy ? 0.6 : 1,
									}}
								>
									Sign Out
								</button>
							) : null}
						</div>

						{loginMsg ? (
							<div
								style={{
									marginTop: 10,
									color: "var(--text-secondary)",
									fontFamily: "var(--font-mono)",
									fontSize: 12,
								}}
							>
								{loginMsg}
							</div>
						) : null}
						{loginErr ? (
							<div
								style={{
									marginTop: 10,
									color: "var(--danger)",
									fontFamily: "var(--font-mono)",
									fontSize: 12,
								}}
							>
								{loginErr}
							</div>
						) : null}

						{signedTeams.length > 0 ? (
							<div style={{ marginTop: 12 }}>
								<div style={labelStyle}>Signed In Workspaces</div>
								<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
									{signedTeams.map((t) => (
										<code key={t} style={tinyCodeStyle}>
											{t} ({session?.teams[t]?.role})
										</code>
									))}
								</div>
							</div>
						) : null}
					</div>

					<div style={{ flexShrink: 0, alignSelf: "flex-start" }}>
						<StatusBadge
							status={session ? "active" : "disabled"}
							label={session ? "signed in" : "signed out"}
						/>
					</div>
				</div>
			</Card>

			{loading ? (
				<div style={{ padding: "40px 0", color: "var(--text-muted)" }}>
					Loading Slack workspaces...
				</div>
			) : workspaces.length === 0 ? (
				<EmptyState
					icon="S"
					title="No workspaces installed"
					description="Install the Slack app to one or more workspaces to begin."
				/>
			) : (
				<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
					{workspaces.map((ws) => (
						<WorkspaceRow
							key={ws.teamId}
							ws={ws}
							canManage={canManage}
							signedIn={!!session?.teams[ws.teamId]}
							onOpen={() =>
								navigate(`/${encodeURIComponent(ws.teamId)}/dashboards`)
							}
							onChanged={refresh}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function WorkspaceRow({
	ws,
	canManage,
	signedIn,
	onOpen,
	onChanged,
}: {
	ws: SlackWorkspace;
	canManage: boolean;
	signedIn: boolean;
	onOpen: () => void;
	onChanged: () => void;
}) {
	const [busy, setBusy] = useState(false);

	const action = async (fn: () => Promise<unknown>) => {
		setBusy(true);
		try {
			await fn();
			onChanged();
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "flex-start",
					gap: 16,
					flexWrap: "wrap",
				}}
			>
				<div style={{ flex: 1, minWidth: 260 }}>
					<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
						<div
							style={{
								width: 32,
								height: 32,
								borderRadius: "var(--radius-md)",
								background: "var(--bg-input)",
								border: "1px solid var(--border)",
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								flexShrink: 0,
								fontFamily: "var(--font-mono)",
								fontSize: 12,
								color: "var(--text-secondary)",
							}}
						>
							WS
						</div>
						<div>
							<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
								<span
									style={{
										fontWeight: 700,
										fontSize: 14,
										fontFamily: "var(--font-display)",
										letterSpacing: "-0.01em",
									}}
								>
									{ws.teamName}
								</span>
								<StatusBadge status={ws.status} />
							</div>
							<div
								style={{
									display: "flex",
									alignItems: "center",
									gap: 8,
									marginTop: 4,
									flexWrap: "wrap",
								}}
							>
								<code style={tinyCodeStyle}>{ws.teamId}</code>
								<span style={{ color: "var(--text-muted)", fontSize: 11 }}>
									installed {new Date(ws.installedAt).toLocaleString()}
								</span>
							</div>
						</div>
					</div>
				</div>

				<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
					<button
						type="button"
						disabled={busy}
						onClick={onOpen}
						style={{
							...btnSecondaryStyle,
							borderColor: signedIn ? "rgba(45,212,191,0.25)" : "var(--border)",
						}}
					>
						Open
					</button>

					{!canManage ? null : ws.status === "active" ? (
						<button
							type="button"
							disabled={busy}
							onClick={() =>
								action(() => api.slack.workspaces.suspend(ws.teamId))
							}
							style={btnSecondaryStyle}
						>
							Suspend
						</button>
					) : ws.status === "suspended" ? (
						<button
							type="button"
							disabled={busy}
							onClick={() =>
								action(() => api.slack.workspaces.reactivate(ws.teamId))
							}
							style={btnSecondaryStyle}
						>
							Reactivate
						</button>
					) : null}

					{!canManage ? null : ws.status !== "uninstalled" ? (
						<button
							type="button"
							disabled={busy}
							onClick={() =>
								action(() => api.slack.workspaces.uninstall(ws.teamId))
							}
							style={btnGhostStyle}
						>
							Mark Uninstalled
						</button>
					) : null}

					{!canManage ? null : (
						<button
							type="button"
							disabled={busy}
							onClick={() => {
								if (
									!confirm(`Remove workspace "${ws.teamName}" (${ws.teamId})?`)
								)
									return;
								action(() => api.slack.workspaces.remove(ws.teamId));
							}}
							style={{
								...btnGhostStyle,
								color: "var(--danger)",
							}}
						>
							Remove
						</button>
					)}
				</div>
			</div>
		</Card>
	);
}

/* ── Styles ─────────────────────────────── */

const headerStyle: React.CSSProperties = {
	fontSize: 24,
	fontWeight: 800,
	letterSpacing: "-0.03em",
	fontFamily: "var(--font-display)",
	lineHeight: 1.2,
};

const subtitleStyle: React.CSSProperties = {
	fontSize: 13,
	color: "var(--text-muted)",
	marginTop: 4,
	fontFamily: "var(--font-mono)",
};

const noticeStyle: React.CSSProperties = {
	background: "var(--info-dim)",
	border: "1px solid rgba(96,165,250,0.2)",
	borderRadius: "var(--radius-lg)",
	padding: "12px 14px",
	fontSize: 12,
	color: "var(--info)",
	display: "flex",
	alignItems: "center",
	gap: 10,
	marginBottom: 14,
};

const errorStyle: React.CSSProperties = {
	background: "var(--danger-dim)",
	border: "1px solid rgba(248,113,113,0.15)",
	borderRadius: "var(--radius-lg)",
	padding: "12px 14px",
	fontSize: 12,
	color: "var(--danger)",
	display: "flex",
	alignItems: "center",
	gap: 10,
	marginBottom: 14,
};

const cardTitleStyle: React.CSSProperties = {
	fontSize: 12,
	fontWeight: 700,
	color: "var(--text-secondary)",
	fontFamily: "var(--font-mono)",
	letterSpacing: "0.04em",
	textTransform: "uppercase",
};

const cardHintStyle: React.CSSProperties = {
	fontSize: 12,
	color: "var(--text-muted)",
	marginTop: 6,
	lineHeight: 1.6,
	maxWidth: 760,
};

const labelStyle: React.CSSProperties = {
	display: "block",
	fontSize: 10,
	fontWeight: 700,
	color: "var(--text-muted)",
	textTransform: "uppercase",
	letterSpacing: "0.08em",
	fontFamily: "var(--font-mono)",
	marginBottom: 6,
};

const codeBlockStyle: React.CSSProperties = {
	display: "block",
	background: "var(--bg-input)",
	border: "1px solid var(--border-subtle)",
	borderRadius: "var(--radius-md)",
	padding: "10px 12px",
	fontSize: 11,
	color: "var(--text-secondary)",
	fontFamily: "var(--font-mono)",
	whiteSpace: "pre-wrap",
	wordBreak: "break-word",
	lineHeight: 1.5,
};

const tinyCodeStyle: React.CSSProperties = {
	fontSize: 11,
	background: "var(--bg-input)",
	color: "var(--text-secondary)",
	padding: "2px 8px",
	borderRadius: "var(--radius)",
	fontFamily: "var(--font-mono)",
	border: "1px solid var(--border-subtle)",
};

const btnPrimaryStyle: React.CSSProperties = {
	background: "var(--accent)",
	color: "var(--text-inverse)",
	border: "none",
	borderRadius: "var(--radius-md)",
	padding: "8px 16px",
	fontSize: 13,
	fontWeight: 600,
	cursor: "pointer",
	transition: "all var(--duration-fast) ease",
	fontFamily: "var(--font-body)",
	display: "flex",
	alignItems: "center",
	gap: 6,
	letterSpacing: "-0.01em",
};

const btnSecondaryStyle: React.CSSProperties = {
	background: "var(--bg-elevated)",
	color: "var(--text-secondary)",
	border: "1px solid var(--border)",
	borderRadius: "var(--radius-md)",
	padding: "7px 14px",
	fontSize: 12,
	fontWeight: 500,
	cursor: "pointer",
	transition: "all var(--duration-fast) ease",
	fontFamily: "var(--font-body)",
};

const btnGhostStyle: React.CSSProperties = {
	background: "transparent",
	color: "var(--text-muted)",
	border: "1px solid var(--border)",
	borderRadius: "var(--radius-md)",
	padding: "7px 12px",
	fontSize: 12,
	fontWeight: 500,
	cursor: "pointer",
	transition: "all var(--duration-fast) ease",
	fontFamily: "var(--font-body)",
};

const inputStyle: React.CSSProperties = {
	background: "var(--bg-input)",
	border: "1px solid var(--border)",
	borderRadius: "var(--radius-md)",
	padding: "9px 12px",
	fontSize: 13,
	color: "var(--text-primary)",
	outline: "none",
	fontFamily: "var(--font-mono)",
	transition: "border-color var(--duration-fast) ease",
};
