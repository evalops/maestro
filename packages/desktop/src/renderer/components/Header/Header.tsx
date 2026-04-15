/**
 * Header Component
 *
 * Premium custom titlebar with macOS traffic light integration.
 */

import { useEffect, useState } from "react";
import { getModelKey } from "../../lib/model-utils";
import type { Model } from "../../lib/types";

export interface HeaderProps {
	currentModel: Model | null;
	models: Model[];
	onModelChange: (modelId: string) => void;
	sidebarOpen: boolean;
	onToggleSidebar: () => void;
}

export function Header({
	currentModel,
	models,
	onModelChange,
	sidebarOpen,
	onToggleSidebar,
}: HeaderProps) {
	const [isMaximized, setIsMaximized] = useState(false);
	const [showModelDropdown, setShowModelDropdown] = useState(false);
	const currentModelKey = currentModel ? getModelKey(currentModel) : "";
	const isMac =
		window.electron?.isMac ?? navigator.platform.toLowerCase().includes("mac");

	useEffect(() => {
		const checkMaximized = async () => {
			if (window.electron?.isMaximized) {
				const maximized = await window.electron.isMaximized();
				setIsMaximized(maximized);
			}
		};
		checkMaximized();
	}, []);

	const handleMinimize = () => window.electron?.minimize();
	const handleMaximize = async () => {
		await window.electron?.maximize();
		const maximized = await window.electron?.isMaximized();
		setIsMaximized(maximized ?? false);
	};
	const handleClose = () => window.electron?.close();

	return (
		<header
			className="titlebar-drag-region relative z-20"
			style={{
				height: "var(--titlebar-height)",
				background:
					"linear-gradient(180deg, rgba(12, 12, 18, 0.95) 0%, rgba(6, 6, 10, 0.9) 100%)",
				backdropFilter: "blur(20px) saturate(180%)",
				WebkitBackdropFilter: "blur(20px) saturate(180%)",
			}}
		>
			<div className="flex items-center justify-between h-full px-5">
				{/* Left: Traffic lights spacer on macOS + sidebar toggle */}
				<div
					className="flex items-center gap-2"
					style={{ paddingLeft: isMac ? "68px" : "0" }}
				>
					{/* Sidebar toggle */}
					<button
						type="button"
						onClick={onToggleSidebar}
						className="titlebar-no-drag p-1.5 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/50 transition-all duration-200"
						title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
					>
						<svg
							aria-hidden="true"
							width="18"
							height="18"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							{sidebarOpen ? (
								<>
									<rect x="3" y="3" width="18" height="18" rx="2" />
									<line x1="9" y1="3" x2="9" y2="21" />
								</>
							) : (
								<>
									<rect x="3" y="3" width="18" height="18" rx="2" />
									<line x1="9" y1="3" x2="9" y2="21" />
									<polyline points="14 9 17 12 14 15" />
								</>
							)}
						</svg>
					</button>

					{/* Logo and title */}
					<div className="flex items-center gap-2.5 ml-2">
						<div
							className="w-6 h-6 rounded-lg flex items-center justify-center"
							style={{
								background:
									"linear-gradient(135deg, var(--accent) 0%, var(--accent-muted) 100%)",
								boxShadow: "0 2px 8px -2px var(--accent-glow)",
							}}
						>
							<svg
								aria-hidden="true"
								width="12"
								height="12"
								viewBox="0 0 24 24"
								fill="none"
								stroke="white"
								strokeWidth="2.5"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<path d="M12 2L2 7l10 5 10-5-10-5z" />
								<path d="M2 17l10 5 10-5" />
								<path d="M2 12l10 5 10-5" />
							</svg>
						</div>
						<span
							className="text-sm font-semibold text-text-primary"
							style={{ letterSpacing: "-0.02em" }}
						>
							Maestro
						</span>
					</div>
				</div>

				{/* Center: Model selector */}
				<div className="absolute left-1/2 -translate-x-1/2 titlebar-no-drag">
					<div className="relative">
						<button
							type="button"
							onClick={() => setShowModelDropdown(!showModelDropdown)}
							className="group flex items-center gap-2.5 px-4 py-2 rounded-xl text-sm
								bg-bg-tertiary/30 hover:bg-bg-tertiary/60 border border-line-subtle/50 hover:border-line-subtle
								transition-all duration-200"
							style={{
								backdropFilter: "blur(8px)",
							}}
						>
							<span className="w-2 h-2 rounded-full bg-success shadow-[0_0_6px_var(--success-glow)]" />
							<span className="text-text-primary font-medium truncate max-w-[200px]">
								{currentModel?.name ?? "Select Model"}
							</span>
							<svg
								aria-hidden="true"
								className={`w-3 h-3 text-text-muted transition-transform duration-200 ${
									showModelDropdown ? "rotate-180" : ""
								}`}
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
								strokeWidth="2.5"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									d="M19 9l-7 7-7-7"
								/>
							</svg>
						</button>

						{/* Model dropdown */}
						{showModelDropdown && (
							<>
								<div
									className="fixed inset-0 z-40"
									onClick={() => setShowModelDropdown(false)}
									onKeyDown={(e) =>
										e.key === "Escape" && setShowModelDropdown(false)
									}
									tabIndex={-1}
									role="presentation"
								/>
								<div
									className="absolute left-1/2 -translate-x-1/2 mt-3 w-[340px] max-h-[420px] overflow-auto z-50
										rounded-2xl animate-slide-up"
									style={{
										background:
											"linear-gradient(180deg, rgba(20, 20, 25, 0.98) 0%, rgba(12, 12, 18, 0.98) 100%)",
										backdropFilter: "blur(20px) saturate(180%)",
										border: "1px solid var(--border-subtle)",
										boxShadow:
											"0 25px 60px -12px rgba(0, 0, 0, 0.7), 0 0 0 1px var(--border-subtle)",
									}}
								>
									<div className="p-3">
										<div className="px-3 py-2 text-label text-text-muted">
											Select Model
										</div>
										{models.map((model) => (
											<button
												type="button"
												key={getModelKey(model)}
												onClick={() => {
													onModelChange(getModelKey(model));
													setShowModelDropdown(false);
												}}
												className={`w-full flex items-start gap-3 p-3 rounded-xl text-left transition-all duration-150 ${
													currentModelKey === getModelKey(model)
														? "bg-accent-subtle border border-line-glow"
														: "hover:bg-bg-tertiary/50 border border-transparent"
												}`}
											>
												<span
													className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 transition-colors ${
														currentModelKey === getModelKey(model)
															? "bg-accent"
															: "bg-text-muted"
													}`}
												/>
												<div className="flex-1 min-w-0">
													<div
														className={`font-medium truncate ${
															currentModelKey === getModelKey(model)
																? "text-accent-hover"
																: "text-text-primary"
														}`}
													>
														{model.name}
													</div>
													{model.description && (
														<div className="text-xs text-text-secondary line-clamp-2 mt-0.5">
															{model.description}
														</div>
													)}
													<div className="text-[10px] text-text-tertiary mt-1">
														{model.provider}
													</div>
												</div>
											</button>
										))}
										{models.length === 0 && (
											<div className="px-3 py-8 text-center text-text-tertiary text-sm">
												Loading models...
											</div>
										)}
									</div>
								</div>
							</>
						)}
					</div>
				</div>

				{/* Right: Window controls (Windows/Linux) or status */}
				{isMac ? (
					<div className="flex items-center gap-3">
						<div
							className="flex items-center gap-2 px-3 py-1.5 rounded-lg"
							style={{
								background: "rgba(16, 185, 129, 0.08)",
								border: "1px solid rgba(16, 185, 129, 0.15)",
							}}
						>
							<div className="w-1.5 h-1.5 rounded-full bg-success animate-pulse-soft" />
							<span className="text-[11px] font-medium text-success">
								Ready
							</span>
						</div>
					</div>
				) : (
					<div className="titlebar-no-drag flex items-center -mr-4">
						<button
							type="button"
							onClick={handleMinimize}
							className="w-11 h-[var(--titlebar-height)] flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/50 transition-colors"
						>
							<svg aria-hidden="true" width="10" height="1" fill="currentColor">
								<rect width="10" height="1" />
							</svg>
						</button>
						<button
							type="button"
							onClick={handleMaximize}
							className="w-11 h-[var(--titlebar-height)] flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/50 transition-colors"
						>
							{isMaximized ? (
								<svg
									aria-hidden="true"
									width="10"
									height="10"
									fill="none"
									stroke="currentColor"
									strokeWidth="1"
								>
									<path d="M2 3.5h5.5V9H2V3.5z M3.5 3.5V2H9v5.5H7.5" />
								</svg>
							) : (
								<svg
									aria-hidden="true"
									width="10"
									height="10"
									fill="none"
									stroke="currentColor"
									strokeWidth="1"
								>
									<rect x="0.5" y="0.5" width="9" height="9" />
								</svg>
							)}
						</button>
						<button
							type="button"
							onClick={handleClose}
							className="w-11 h-[var(--titlebar-height)] flex items-center justify-center text-text-tertiary hover:text-white hover:bg-error transition-colors"
						>
							<svg
								aria-hidden="true"
								width="10"
								height="10"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.5"
							>
								<path d="M1 1l8 8M9 1l-8 8" />
							</svg>
						</button>
					</div>
				)}
			</div>
		</header>
	);
}
