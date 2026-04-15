import { useMemo } from "react";

export type AppearanceThemeMode = "system" | "dark" | "light";
export type AppearanceDensityMode = "comfortable" | "compact";

export interface AppearanceViewModel {
	themeMode: AppearanceThemeMode;
	showTimestampsLabel: string;
	isComfortableSelected: boolean;
	isCompactSelected: boolean;
}

export interface AppearanceSectionProps {
	themeMode: AppearanceThemeMode;
	showTimestamps: boolean;
	density: AppearanceDensityMode;
	onUpdateTheme: (mode: AppearanceThemeMode) => Promise<void> | void;
	onToggleTimestamps: (enabled: boolean) => void;
	onSetDensity: (density: AppearanceDensityMode) => void;
}

export function buildAppearanceViewModel(
	themeMode: AppearanceThemeMode,
	showTimestamps: boolean,
	density: AppearanceDensityMode,
): AppearanceViewModel {
	return {
		themeMode,
		showTimestampsLabel: showTimestamps ? "On" : "Off",
		isComfortableSelected: density === "comfortable",
		isCompactSelected: density === "compact",
	};
}

export function AppearanceSection({
	themeMode,
	showTimestamps,
	density,
	onUpdateTheme,
	onToggleTimestamps,
	onSetDensity,
}: AppearanceSectionProps) {
	const appearance = useMemo(
		() => buildAppearanceViewModel(themeMode, showTimestamps, density),
		[density, showTimestamps, themeMode],
	);

	return (
		<section className="border border-line-subtle rounded-xl overflow-hidden">
			<div className="px-4 py-2 text-xs font-semibold text-text-tertiary border-b border-line-subtle uppercase tracking-wide">
				Appearance
			</div>
			<div className="p-4 space-y-4">
				<div className="flex items-center justify-between gap-4">
					<div>
						<div className="text-text-primary font-medium">Theme</div>
						<div className="text-xs text-text-muted">
							System, dark, or light.
						</div>
					</div>
					<select
						value={appearance.themeMode}
						onChange={(event) =>
							onUpdateTheme(event.target.value as AppearanceThemeMode)
						}
						className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary"
					>
						<option value="system">System</option>
						<option value="dark">Dark</option>
						<option value="light">Light</option>
					</select>
				</div>

				<div className="flex items-center justify-between gap-4">
					<div>
						<div className="text-text-primary font-medium">Show timestamps</div>
						<div className="text-xs text-text-muted">
							Display message time in the chat header.
						</div>
					</div>
					<label className="inline-flex items-center gap-2 text-xs text-text-tertiary">
						<input
							type="checkbox"
							checked={showTimestamps}
							onChange={(event) => onToggleTimestamps(event.target.checked)}
							className="h-4 w-4 rounded border-line-subtle bg-bg-tertiary text-accent focus:ring-accent"
						/>
						<span>{appearance.showTimestampsLabel}</span>
					</label>
				</div>

				<div>
					<div className="text-text-primary font-medium">Density</div>
					<div className="text-xs text-text-muted mb-2">
						Control spacing between messages.
					</div>
					<div className="flex items-center gap-2">
						<button
							type="button"
							className={`px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
								appearance.isComfortableSelected
									? "border-accent text-text-primary bg-bg-tertiary"
									: "border-line-subtle text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
							}`}
							onClick={() => onSetDensity("comfortable")}
						>
							Comfortable
						</button>
						<button
							type="button"
							className={`px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
								appearance.isCompactSelected
									? "border-accent text-text-primary bg-bg-tertiary"
									: "border-line-subtle text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
							}`}
							onClick={() => onSetDensity("compact")}
						>
							Compact
						</button>
					</div>
				</div>
			</div>
		</section>
	);
}
