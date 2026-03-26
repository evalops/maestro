import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { type TriggerInfo, api } from "../api/client";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { StatusBadge } from "../components/StatusBadge";

function hasBearerToken(): boolean {
	try {
		return !!localStorage.getItem("slack_agent_ui_token");
	} catch {
		return false;
	}
}

export function TriggersPage() {
	const { teamId } = useParams<{ teamId: string }>();
	const [triggers, setTriggers] = useState<TriggerInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [showAdd, setShowAdd] = useState(false);
	const [canManage, setCanManage] = useState(false);

	const refresh = useCallback(() => {
		if (!teamId) return;
		setLoading(true);
		setError(null);
		Promise.all([api.workspaces(teamId).triggers.list(), api.auth.me()])
			.then(([t, me]) => {
				setTriggers(t);
				const role = me.ok ? me.session?.teams?.[teamId]?.role : undefined;
				setCanManage(
					hasBearerToken() || role === "admin" || role === "power_user",
				);
			})
			.catch((e) => setError(e.message))
			.finally(() => setLoading(false));
	}, [teamId]);

	useEffect(() => {
		refresh();
	}, [refresh]);

	if (loading) return <Shimmer />;
	if (error) return <ErrorMsg message={error} />;
	if (!teamId) return <ErrorMsg message="Missing workspace teamId in URL." />;

	return (
		<div style={{ animation: "fadeUp 0.4s var(--ease-out) both" }}>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "flex-start",
					marginBottom: 24,
				}}
			>
				<div>
					<h2 style={headerStyle}>Webhook Triggers</h2>
					<p style={subtitleStyle}>
						Auto-run the agent when webhook events arrive
					</p>
					<p
						style={{
							marginTop: 10,
							fontSize: 12,
							color: "var(--text-muted)",
							fontFamily: "var(--font-mono)",
						}}
					>
						Endpoint:{" "}
						<code style={{ color: "var(--text-secondary)" }}>
							POST {window.location.origin}/webhooks/{teamId}/{"{source}"}
						</code>
					</p>
				</div>
				{canManage ? (
					<button
						type="button"
						onClick={() => setShowAdd(true)}
						style={btnPrimaryStyle}
					>
						<span style={{ fontSize: 14, lineHeight: 1 }}>+</span>
						Add Trigger
					</button>
				) : (
					<StatusBadge status="disabled" label="read-only" />
				)}
			</div>

			{canManage && showAdd && (
				<div
					style={{
						animation: "slideDown 0.25s var(--ease-out) both",
					}}
				>
					<AddTriggerForm
						teamId={teamId}
						onAdded={() => {
							setShowAdd(false);
							refresh();
						}}
						onCancel={() => setShowAdd(false)}
					/>
				</div>
			)}

			{triggers.length === 0 ? (
				<EmptyState
					icon="↯"
					title="No triggers"
					description="Create a trigger to auto-run the agent when GitHub pushes, Stripe events, or other webhooks arrive."
				/>
			) : (
				<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
					{triggers.map((t, i) => (
						<div
							key={t.id}
							style={{
								animation: "fadeUp 0.35s var(--ease-out) both",
								animationDelay: `${60 + i * 30}ms`,
							}}
						>
							<TriggerRow
								trigger={t}
								teamId={teamId}
								canManage={canManage}
								onRemoved={refresh}
							/>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function TriggerRow({
	trigger,
	teamId,
	canManage,
	onRemoved,
}: {
	trigger: TriggerInfo;
	teamId: string;
	canManage: boolean;
	onRemoved: () => void;
}) {
	const [removing, setRemoving] = useState(false);

	const handleRemove = async () => {
		if (!confirm("Remove this trigger?")) return;
		setRemoving(true);
		try {
			await api.workspaces(teamId).triggers.remove(trigger.id);
			onRemoved();
		} catch {
			setRemoving(false);
		}
	};

	return (
		<Card>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "flex-start",
				}}
			>
				<div style={{ flex: 1 }}>
					<div
						style={{
							display: "flex",
							alignItems: "center",
							gap: 8,
							marginBottom: 10,
							flexWrap: "wrap",
						}}
					>
						<code style={sourceBadgeStyle}>{trigger.source}</code>
						<svg
							aria-hidden="true"
							width="12"
							height="12"
							viewBox="0 0 12 12"
							fill="none"
							stroke="var(--text-muted)"
							strokeWidth="1.5"
							strokeLinecap="round"
						>
							<line x1="2" y1="6" x2="10" y2="6" />
							<polyline points="7 3.5 10 6 7 8.5" />
						</svg>
						<code style={channelBadgeStyle}>#{trigger.channel}</code>
						<StatusBadge
							status={trigger.enabled ? "active" : "disabled"}
							label={trigger.enabled ? "on" : "off"}
						/>
					</div>
					<div
						style={{
							color: "var(--text-primary)",
							fontFamily: "var(--font-mono)",
							background: "var(--bg-input)",
							padding: "10px 14px",
							borderRadius: "var(--radius-md)",
							lineHeight: 1.6,
							border: "1px solid var(--border-subtle)",
							fontSize: 12,
						}}
					>
						{trigger.prompt}
					</div>
					{trigger.filter && Object.keys(trigger.filter).length > 0 && (
						<p
							style={{
								fontSize: 11,
								color: "var(--text-muted)",
								marginTop: 8,
								fontFamily: "var(--font-mono)",
							}}
						>
							filter: {JSON.stringify(trigger.filter)}
						</p>
					)}
				</div>
				{canManage ? (
					<button
						type="button"
						onClick={handleRemove}
						disabled={removing}
						style={{
							...btnGhostStyle,
							color: "var(--danger)",
							marginLeft: 16,
							opacity: removing ? 0.5 : 1,
							flexShrink: 0,
						}}
					>
						{removing ? "..." : "Remove"}
					</button>
				) : null}
			</div>
		</Card>
	);
}

function AddTriggerForm({
	teamId,
	onAdded,
	onCancel,
}: { teamId: string; onAdded: () => void; onCancel: () => void }) {
	const [source, setSource] = useState("github");
	const [channel, setChannel] = useState("");
	const [prompt, setPrompt] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!channel.trim() || !prompt.trim()) return;
		setSubmitting(true);
		setErr(null);
		try {
			await api.workspaces(teamId).triggers.add({
				source,
				channel: channel.trim(),
				prompt: prompt.trim(),
				enabled: true,
			});
			onAdded();
		} catch (error) {
			setErr(error instanceof Error ? error.message : "Failed");
		} finally {
			setSubmitting(false);
		}
	};

	const sources = ["github", "stripe", "linear", "custom", "*"];

	return (
		<Card
			style={{
				marginBottom: 16,
				borderColor: "var(--border-accent)",
			}}
		>
			<p style={formTitleStyle}>New Trigger</p>
			<form
				onSubmit={handleSubmit}
				style={{ display: "flex", flexDirection: "column", gap: 14 }}
			>
				<div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
					<label style={labelStyle}>
						Source
						<select
							value={source}
							onChange={(e) => setSource(e.target.value)}
							style={inputStyle}
						>
							{sources.map((s) => (
								<option key={s} value={s}>
									{s === "*" ? "* (any)" : s}
								</option>
							))}
						</select>
					</label>
					<label style={labelStyle}>
						Channel ID
						<input
							value={channel}
							onChange={(e) => setChannel(e.target.value)}
							placeholder="C01ABCDEF"
							style={inputStyle}
						/>
					</label>
				</div>
				<label style={labelStyle}>
					Prompt Template
					<textarea
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
						placeholder="Review this PR: {{summary}}"
						rows={2}
						style={{ ...inputStyle, resize: "vertical", minWidth: "100%" }}
					/>
					<span
						style={{
							fontSize: 10,
							color: "var(--text-muted)",
							fontWeight: 400,
							textTransform: "none",
							letterSpacing: "normal",
						}}
					>
						{"Use {{summary}}, {{source}}, {{timestamp}} as template variables"}
					</span>
				</label>
				<div style={{ display: "flex", gap: 6 }}>
					<button type="submit" disabled={submitting} style={btnPrimaryStyle}>
						{submitting ? "Adding..." : "Add Trigger"}
					</button>
					<button type="button" onClick={onCancel} style={btnSecondaryStyle}>
						Cancel
					</button>
				</div>
				{err && (
					<span style={{ color: "var(--danger)", fontSize: 12 }}>{err}</span>
				)}
			</form>
		</Card>
	);
}

function Shimmer() {
	return (
		<div style={{ padding: "40px 0" }}>
			{[1, 2].map((i) => (
				<div
					key={i}
					style={{
						height: 80,
						background: "var(--bg-card)",
						borderRadius: "var(--radius-xl)",
						marginBottom: 10,
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

function ErrorMsg({ message }: { message: string }) {
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
			{message}
		</div>
	);
}

/* ── Shared styles ─────────────────────────────── */

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

const formTitleStyle: React.CSSProperties = {
	fontSize: 12,
	fontWeight: 600,
	color: "var(--accent)",
	fontFamily: "var(--font-mono)",
	letterSpacing: "0.02em",
	marginBottom: 12,
	textTransform: "uppercase",
};

const sourceBadgeStyle: React.CSSProperties = {
	fontSize: 11,
	background: "var(--info-dim)",
	color: "var(--info)",
	padding: "3px 10px",
	borderRadius: 999,
	fontWeight: 500,
	fontFamily: "var(--font-mono)",
};

const channelBadgeStyle: React.CSSProperties = {
	fontSize: 11,
	background: "var(--bg-elevated)",
	color: "var(--text-secondary)",
	padding: "3px 10px",
	borderRadius: 999,
	fontWeight: 500,
	fontFamily: "var(--font-mono)",
	border: "1px solid var(--border)",
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
	border: "none",
	borderRadius: "var(--radius-md)",
	padding: "7px 12px",
	fontSize: 12,
	fontWeight: 500,
	cursor: "pointer",
	transition: "all var(--duration-fast) ease",
	fontFamily: "var(--font-body)",
};

const labelStyle: React.CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: 5,
	fontSize: 11,
	fontWeight: 600,
	color: "var(--text-muted)",
	textTransform: "uppercase",
	letterSpacing: "0.04em",
	fontFamily: "var(--font-mono)",
};

const inputStyle: React.CSSProperties = {
	background: "var(--bg-input)",
	border: "1px solid var(--border)",
	borderRadius: "var(--radius-md)",
	padding: "9px 12px",
	fontSize: 13,
	color: "var(--text-primary)",
	outline: "none",
	minWidth: 180,
	fontFamily: "var(--font-mono)",
	transition: "border-color var(--duration-fast) ease",
};
