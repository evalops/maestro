import type { CSSProperties, ReactNode } from "react";

interface CardProps {
	children: ReactNode;
	onClick?: () => void;
	style?: CSSProperties;
}

export function Card({ children, onClick, style }: CardProps) {
	return (
		<div
			role={onClick ? "button" : undefined}
			tabIndex={onClick ? 0 : undefined}
			onClick={onClick}
			onKeyDown={onClick ? (e) => e.key === "Enter" && onClick() : undefined}
			style={{
				background: "var(--bg-card)",
				border: "1px solid var(--border)",
				borderRadius: "var(--radius-xl)",
				padding: 20,
				cursor: onClick ? "pointer" : undefined,
				transition: "all var(--duration-normal) var(--ease-out)",
				position: "relative",
				overflow: "hidden",
				...style,
			}}
			onMouseEnter={(e) => {
				if (onClick) {
					e.currentTarget.style.background = "var(--bg-card-hover)";
					e.currentTarget.style.borderColor = "var(--border-focus)";
					e.currentTarget.style.boxShadow = "var(--shadow-md)";
					e.currentTarget.style.transform = "translateY(-1px)";
				}
			}}
			onMouseLeave={(e) => {
				if (onClick) {
					e.currentTarget.style.background = "var(--bg-card)";
					e.currentTarget.style.borderColor = "";
					e.currentTarget.style.boxShadow = "none";
					e.currentTarget.style.transform = "translateY(0)";
				}
			}}
		>
			{children}
		</div>
	);
}
