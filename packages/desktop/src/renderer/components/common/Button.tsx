/**
 * Button Component
 *
 * Reusable button component with multiple variants.
 */

import { type ButtonHTMLAttributes, forwardRef } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: "primary" | "secondary" | "ghost" | "danger";
	size?: "sm" | "md" | "lg";
	loading?: boolean;
	icon?: React.ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
	(
		{
			variant = "primary",
			size = "md",
			loading = false,
			icon,
			children,
			className = "",
			disabled,
			...props
		},
		ref,
	) => {
		const baseStyles =
			"inline-flex items-center justify-center font-medium rounded-lg transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary disabled:opacity-50 disabled:cursor-not-allowed";

		const variants = {
			primary:
				"bg-accent hover:bg-accent-hover text-white focus-visible:ring-accent",
			secondary:
				"bg-bg-tertiary hover:bg-bg-elevated text-text-primary border border-border focus-visible:ring-border",
			ghost:
				"bg-transparent hover:bg-bg-tertiary text-text-secondary hover:text-text-primary focus-visible:ring-border",
			danger: "bg-error hover:bg-error/80 text-white focus-visible:ring-error",
		};

		const sizes = {
			sm: "px-3 py-1.5 text-xs gap-1.5",
			md: "px-4 py-2 text-sm gap-2",
			lg: "px-5 py-2.5 text-base gap-2",
		};

		return (
			<button
				type="button"
				ref={ref}
				disabled={disabled || loading}
				className={`${baseStyles} ${variants[variant]} ${sizes[size]} ${className}`}
				{...props}
			>
				{loading ? (
					<svg
						aria-hidden="true"
						className="animate-spin h-4 w-4"
						xmlns="http://www.w3.org/2000/svg"
						fill="none"
						viewBox="0 0 24 24"
					>
						<circle
							className="opacity-25"
							cx="12"
							cy="12"
							r="10"
							stroke="currentColor"
							strokeWidth="4"
						/>
						<path
							className="opacity-75"
							fill="currentColor"
							d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
						/>
					</svg>
				) : icon ? (
					<span className="flex-shrink-0">{icon}</span>
				) : null}
				{children}
			</button>
		);
	},
);

Button.displayName = "Button";
