import type { CSSProperties } from "react";

interface EmptyStateProps {
	icon: string;
	title: string;
	description: string;
}

export function EmptyState({ icon, title, description }: EmptyStateProps) {
	const containerStyle: CSSProperties = {
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		padding: "72px 24px",
		textAlign: "center",
	};
	return (
		<div style={containerStyle}>
			<div
				style={{
					width: 64,
					height: 64,
					borderRadius: "var(--radius-xl)",
					background: "var(--bg-card)",
					border: "1px solid var(--border)",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					fontSize: 28,
					marginBottom: 20,
					opacity: 0.6,
				}}
			>
				{icon}
			</div>
			<h3
				style={{
					fontSize: 15,
					fontWeight: 600,
					marginBottom: 6,
					fontFamily: "var(--font-display)",
					letterSpacing: "-0.01em",
				}}
			>
				{title}
			</h3>
			<p
				style={{
					fontSize: 13,
					color: "var(--text-muted)",
					maxWidth: 340,
					lineHeight: 1.6,
				}}
			>
				{description}
			</p>
		</div>
	);
}
