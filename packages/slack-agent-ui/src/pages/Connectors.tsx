import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { type ConnectorInfo, api } from "../api/client";
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

export function ConnectorsPage() {
	const { teamId } = useParams<{ teamId: string }>();
	const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
	const [types, setTypes] = useState<string[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [showAdd, setShowAdd] = useState(false);
	const [canManage, setCanManage] = useState(false);

	const refresh = useCallback(() => {
		if (!teamId) return;
		setLoading(true);
		setError(null);
		Promise.all([
			api.workspaces(teamId).connectors.list(),
			api.workspaces(teamId).connectors.types(),
			api.auth.me(),
		])
			.then(([c, t, me]) => {
				setConnectors(c);
				setTypes(t);
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
					<h2 style={headerStyle}>Connectors</h2>
					<p style={subtitleStyle}>External service integrations</p>
				</div>
				{canManage ? (
					<button
						type="button"
						onClick={() => setShowAdd(true)}
						style={btnPrimaryStyle}
					>
						<span style={{ fontSize: 14, lineHeight: 1 }}>+</span>
						Add Connector
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
					<AddConnectorForm
						teamId={teamId}
						types={types}
						existingNames={connectors.map((c) => c.name)}
						onAdded={() => {
							setShowAdd(false);
							refresh();
						}}
						onCancel={() => setShowAdd(false)}
					/>
				</div>
			)}

			{connectors.length === 0 ? (
				<EmptyState
					icon="⚡"
					title="No connectors"
					description="Add a connector to let the agent pull data from HubSpot, Stripe, GitHub, and more."
				/>
			) : (
				<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
					{connectors.map((c, i) => (
						<div
							key={c.name}
							style={{
								animation: "fadeUp 0.35s var(--ease-out) both",
								animationDelay: `${60 + i * 30}ms`,
							}}
						>
							<ConnectorRow
								connector={c}
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

function ConnectorRow({
	connector,
	teamId,
	canManage,
	onRemoved,
}: {
	connector: ConnectorInfo;
	teamId: string;
	canManage: boolean;
	onRemoved: () => void;
}) {
	const [showCreds, setShowCreds] = useState(false);
	const [removing, setRemoving] = useState(false);

	const handleRemove = async () => {
		if (!confirm(`Remove connector "${connector.name}"?`)) return;
		setRemoving(true);
		try {
			await api.workspaces(teamId).connectors.remove(connector.name);
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
					alignItems: "center",
				}}
			>
				<div style={{ display: "flex", alignItems: "center", gap: 12 }}>
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
						}}
					>
						<code
							style={{
								fontSize: 10,
								color: "var(--text-secondary)",
								fontWeight: 600,
							}}
						>
							{connector.type.slice(0, 2).toUpperCase()}
						</code>
					</div>
					<div>
						<div
							style={{
								display: "flex",
								alignItems: "center",
								gap: 10,
							}}
						>
							<span
								style={{
									fontWeight: 600,
									fontSize: 14,
									fontFamily: "var(--font-display)",
									letterSpacing: "-0.01em",
								}}
							>
								{connector.name}
							</span>
							<StatusBadge status={connector.status} />
						</div>
						<div
							style={{
								display: "flex",
								alignItems: "center",
								gap: 8,
								marginTop: 3,
							}}
						>
							<code
								style={{
									fontSize: 11,
									color: "var(--text-muted)",
									fontFamily: "var(--font-mono)",
								}}
							>
								{connector.type}
							</code>
							{connector.capabilities != null && (
								<span
									style={{
										fontSize: 11,
										color: "var(--text-muted)",
									}}
								>
									&middot; {connector.capabilities} actions
								</span>
							)}
						</div>
					</div>
				</div>
				<div style={{ display: "flex", gap: 6 }}>
					{canManage && connector.status === "needs_credentials" && (
						<button
							type="button"
							onClick={() => setShowCreds(!showCreds)}
							style={btnSecondaryStyle}
						>
							Set Credentials
						</button>
					)}
					{canManage ? (
						<button
							type="button"
							onClick={handleRemove}
							disabled={removing}
							style={{
								...btnGhostStyle,
								color: "var(--danger)",
								opacity: removing ? 0.5 : 1,
							}}
						>
							{removing ? "..." : "Remove"}
						</button>
					) : null}
				</div>
			</div>
			{canManage && showCreds && (
				<div
					style={{
						animation: "slideDown 0.2s var(--ease-out) both",
					}}
				>
					<CredentialsForm
						name={connector.name}
						teamId={teamId}
						onSaved={() => {
							setShowCreds(false);
							onRemoved();
						}}
					/>
				</div>
			)}
		</Card>
	);
}

function AddConnectorForm({
	teamId,
	types,
	existingNames,
	onAdded,
	onCancel,
}: {
	teamId: string;
	types: string[];
	existingNames: string[];
	onAdded: () => void;
	onCancel: () => void;
}) {
	const [type, setType] = useState(types[0] ?? "");
	const [name, setName] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!name.trim()) return;
		if (existingNames.includes(name.trim())) {
			setErr("Name already exists");
			return;
		}
		setSubmitting(true);
		setErr(null);
		try {
			const res = await api
				.workspaces(teamId)
				.connectors.add(type, name.trim());
			if (!res.ok) setErr(res.message);
			else onAdded();
		} catch (error) {
			setErr(error instanceof Error ? error.message : "Failed");
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Card
			style={{
				marginBottom: 16,
				borderColor: "var(--border-accent)",
			}}
		>
			<p style={formTitleStyle}>New Connector</p>
			<form
				onSubmit={handleSubmit}
				style={{
					display: "flex",
					gap: 12,
					alignItems: "flex-end",
					flexWrap: "wrap",
				}}
			>
				<label style={labelStyle}>
					Type
					<select
						value={type}
						onChange={(e) => setType(e.target.value)}
						style={inputStyle}
					>
						{types.map((t) => (
							<option key={t} value={t}>
								{t}
							</option>
						))}
					</select>
				</label>
				<label style={labelStyle}>
					Name
					<input
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="my-hubspot"
						style={inputStyle}
					/>
				</label>
				<div style={{ display: "flex", gap: 6 }}>
					<button type="submit" disabled={submitting} style={btnPrimaryStyle}>
						{submitting ? "Adding..." : "Add"}
					</button>
					<button type="button" onClick={onCancel} style={btnSecondaryStyle}>
						Cancel
					</button>
				</div>
				{err && (
					<span style={{ color: "var(--danger)", fontSize: 12, width: "100%" }}>
						{err}
					</span>
				)}
			</form>
		</Card>
	);
}

function CredentialsForm({
	name,
	teamId,
	onSaved,
}: { name: string; teamId: string; onSaved: () => void }) {
	const [secret, setSecret] = useState("");
	const [metadata, setMetadata] = useState("");
	const [saving, setSaving] = useState(false);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setSaving(true);
		const meta: Record<string, string> = {};
		if (metadata.trim()) {
			for (const part of metadata.split(",")) {
				const [k, v] = part.split("=").map((s) => s.trim());
				if (k && v) meta[k] = v;
			}
		}
		try {
			await api
				.workspaces(teamId)
				.connectors.setCredentials(
					name,
					secret,
					Object.keys(meta).length > 0 ? meta : undefined,
				);
			onSaved();
		} finally {
			setSaving(false);
		}
	};

	return (
		<form
			onSubmit={handleSubmit}
			style={{
				marginTop: 14,
				paddingTop: 14,
				borderTop: "1px solid var(--border-subtle)",
				display: "flex",
				gap: 12,
				alignItems: "flex-end",
				flexWrap: "wrap",
			}}
		>
			<label style={labelStyle}>
				API Key / Token
				<input
					type="password"
					value={secret}
					onChange={(e) => setSecret(e.target.value)}
					style={inputStyle}
				/>
			</label>
			<label style={labelStyle}>
				Metadata{" "}
				<span style={{ color: "var(--text-muted)", fontSize: 10 }}>
					(key=val,key2=val2)
				</span>
				<input
					value={metadata}
					onChange={(e) => setMetadata(e.target.value)}
					placeholder="baseUrl=https://..."
					style={inputStyle}
				/>
			</label>
			<button
				type="submit"
				disabled={saving || !secret}
				style={btnPrimaryStyle}
			>
				{saving ? "Saving..." : "Save"}
			</button>
		</form>
	);
}

function Shimmer() {
	return (
		<div style={{ padding: "40px 0" }}>
			{[1, 2, 3].map((i) => (
				<div
					key={i}
					style={{
						height: 60,
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
