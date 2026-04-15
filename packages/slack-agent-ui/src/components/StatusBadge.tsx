import type { CSSProperties } from "react";

interface StatusBadgeProps {
	status:
		| "ready"
		| "needs_credentials"
		| "disabled"
		| "error"
		| "active"
		| "suspended"
		| "uninstalled"
		| "expired"
		| "shared"
		| "private";
	label?: string;
}

const statusConfig: Record<string, { bg: string; fg: string; dot: string }> = {
	ready: {
		bg: "var(--success-dim)",
		fg: "var(--success)",
		dot: "var(--success)",
	},
	active: {
		bg: "var(--success-dim)",
		fg: "var(--success)",
		dot: "var(--success)",
	},
	needs_credentials: {
		bg: "var(--warning-dim)",
		fg: "var(--warning)",
		dot: "var(--warning)",
	},
	disabled: {
		bg: "rgba(85,85,94,0.1)",
		fg: "var(--text-muted)",
		dot: "var(--text-muted)",
	},
	suspended: {
		bg: "var(--warning-dim)",
		fg: "var(--warning)",
		dot: "var(--warning)",
	},
	uninstalled: {
		bg: "rgba(85,85,94,0.1)",
		fg: "var(--text-muted)",
		dot: "var(--text-muted)",
	},
	error: {
		bg: "var(--danger-dim)",
		fg: "var(--danger)",
		dot: "var(--danger)",
	},
	expired: {
		bg: "var(--danger-dim)",
		fg: "var(--danger)",
		dot: "var(--danger)",
	},
	shared: {
		bg: "var(--accent-dim)",
		fg: "var(--accent)",
		dot: "var(--accent)",
	},
	private: {
		bg: "rgba(85,85,94,0.1)",
		fg: "var(--text-muted)",
		dot: "var(--text-muted)",
	},
};

export function StatusBadge({ status, label }: StatusBadgeProps) {
	const config = statusConfig[status] ?? statusConfig.disabled;
	const style: CSSProperties = {
		display: "inline-flex",
		alignItems: "center",
		gap: 6,
		padding: "3px 10px",
		borderRadius: 999,
		fontSize: 11,
		fontWeight: 500,
		fontFamily: "var(--font-mono)",
		background: config.bg,
		color: config.fg,
		letterSpacing: "0.01em",
	};
	return (
		<span style={style}>
			<span
				style={{
					width: 5,
					height: 5,
					borderRadius: "50%",
					background: config.dot,
					flexShrink: 0,
				}}
			/>
			{label ?? status.replace(/_/g, " ")}
		</span>
	);
}
