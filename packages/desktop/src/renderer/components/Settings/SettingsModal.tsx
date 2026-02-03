/**
 * SettingsModal Component
 *
 * Comprehensive settings panel for desktop preferences.
 */

import { type ChangeEvent, useEffect, useMemo, useState } from "react";
import {
	type ApprovalMode,
	type BackgroundStatus,
	type CleanMode,
	type ComposerStatus,
	type FooterMode,
	type FrameworkSummary,
	type GuardianStatus,
	type LspStatus,
	type McpStatus,
	type ModeStatus,
	type PlanStatus,
	type QueueMode,
	type TelemetryStatus,
	type TrainingStatus,
	type UiStatus,
	apiClient,
} from "../../lib/api-client";
import type { Model, ThinkingLevel } from "../../lib/types";

export type DensityMode = "comfortable" | "compact";
export type ThemeMode = "system" | "dark" | "light";

export interface DesktopSettings {
	showTimestamps: boolean;
	density: DensityMode;
	thinkingLevel: ThinkingLevel;
}

export interface SettingsModalProps {
	open: boolean;
	settings: DesktopSettings;
	onChange: (settings: DesktopSettings) => void;
	onClose: () => void;
	sessionId?: string | null;
	models?: Model[];
	currentModel?: Model | null;
	onModelChange?: (modelId: string) => Promise<void> | void;
}

const DEFAULT_UI_STATUS: UiStatus = {
	zenMode: false,
	cleanMode: "off",
	footerMode: "ensemble",
	compactTools: false,
	queueMode: "all",
};

const DEFAULT_MODE_OPTIONS = ["smart", "rush", "free", "custom"];

const getModelKey = (model: Model) => `${model.provider}:${model.id}`;

const dedupeModels = (list: Model[]) => {
	const seen = new Set<string>();
	return list.filter((model) => {
		const key = getModelKey(model);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
};

const normalizeModeOptions = (modes: Array<string | { mode: string }>) => {
	const normalized = modes
		.map((entry) => (typeof entry === "string" ? entry : entry.mode))
		.filter((entry): entry is string => Boolean(entry));
	return normalized.length
		? Array.from(new Set(normalized))
		: DEFAULT_MODE_OPTIONS;
};

export function SettingsModal({
	open,
	settings,
	onChange,
	onClose,
	sessionId,
	models,
	currentModel,
	onModelChange,
}: SettingsModalProps) {
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [themeMode, setThemeMode] = useState<ThemeMode>("system");
	const [approvalMode, setApprovalMode] = useState<ApprovalMode>("prompt");
	const [uiStatus, setUiStatus] = useState<UiStatus>(DEFAULT_UI_STATUS);
	const [queueMode, setQueueMode] = useState<QueueMode>("all");
	const [frameworks, setFrameworks] = useState<FrameworkSummary[]>([]);
	const [frameworkId, setFrameworkId] = useState<string>("none");
	const [frameworkScope, setFrameworkScope] = useState<"user" | "workspace">(
		"user",
	);
	const [frameworkLocked, setFrameworkLocked] = useState(false);
	const [telemetryStatus, setTelemetryStatus] =
		useState<TelemetryStatus | null>(null);
	const [trainingStatus, setTrainingStatus] = useState<TrainingStatus | null>(
		null,
	);
	const [modeStatus, setModeStatus] = useState<ModeStatus | null>(null);
	const [modeOptions, setModeOptions] =
		useState<string[]>(DEFAULT_MODE_OPTIONS);
	const [guardianStatus, setGuardianStatus] = useState<GuardianStatus | null>(
		null,
	);
	const [guardianRunning, setGuardianRunning] = useState(false);
	const [planStatus, setPlanStatus] = useState<PlanStatus | null>(null);
	const [planDraft, setPlanDraft] = useState("");
	const [planDirty, setPlanDirty] = useState(false);
	const [planName, setPlanName] = useState("");
	const [backgroundStatus, setBackgroundStatus] =
		useState<BackgroundStatus | null>(null);
	const [lspStatus, setLspStatus] = useState<LspStatus | null>(null);
	const [lspDetections, setLspDetections] = useState<
		Array<{ serverId: string; root: string }>
	>([]);
	const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null);
	const [composerStatus, setComposerStatus] = useState<ComposerStatus | null>(
		null,
	);
	const [selectedComposer, setSelectedComposer] = useState<string>("");
	const [availableModels, setAvailableModels] = useState<Model[]>(
		dedupeModels(models ?? []),
	);
	const [selectedModelId, setSelectedModelId] = useState<string>(() =>
		currentModel ? getModelKey(currentModel) : "",
	);

	const sessionKey = sessionId ?? "default";
	const hasSession = Boolean(sessionId);

	useEffect(() => {
		if (models?.length) {
			setAvailableModels(dedupeModels(models));
		}
	}, [models]);

	useEffect(() => {
		if (currentModel?.id && currentModel.provider) {
			setSelectedModelId(getModelKey(currentModel));
		}
	}, [currentModel]);

	useEffect(() => {
		if (!open) return;
		let active = true;

		const load = async () => {
			setLoading(true);
			setError(null);
			try {
				const results = await Promise.allSettled([
					apiClient.getApprovalMode(sessionKey),
					apiClient.getFrameworkPreference(),
					apiClient.listFrameworks(),
					apiClient.getTelemetryStatus(),
					apiClient.getTrainingStatus(),
					apiClient.getModeStatus(),
					apiClient.listModes(),
					apiClient.getGuardianStatus(),
					apiClient.getPlan(),
					apiClient.getBackgroundStatus(),
					apiClient.getLspStatus(),
					apiClient.getMcpStatus(),
					apiClient.getComposers(),
				]);
				if (!active) return;

				const [
					approvalRes,
					frameworkRes,
					frameworkListRes,
					telemetryRes,
					trainingRes,
					modeRes,
					modeListRes,
					guardianRes,
					planRes,
					backgroundRes,
					lspRes,
					mcpRes,
					composerRes,
				] = results;

				if (approvalRes.status === "fulfilled") {
					setApprovalMode(approvalRes.value.mode);
				}
				if (frameworkRes.status === "fulfilled") {
					setFrameworkId(frameworkRes.value.framework ?? "none");
					setFrameworkScope(frameworkRes.value.scope ?? "user");
					setFrameworkLocked(Boolean(frameworkRes.value.locked));
				}
				if (frameworkListRes.status === "fulfilled") {
					setFrameworks(frameworkListRes.value.frameworks ?? []);
				}
				if (telemetryRes.status === "fulfilled") {
					setTelemetryStatus(telemetryRes.value);
				}
				if (trainingRes.status === "fulfilled") {
					setTrainingStatus(trainingRes.value);
				}
				if (modeRes.status === "fulfilled") {
					setModeStatus(modeRes.value);
				}
				if (modeListRes.status === "fulfilled") {
					setModeOptions(normalizeModeOptions(modeListRes.value.modes ?? []));
				}
				if (guardianRes.status === "fulfilled") {
					setGuardianStatus(guardianRes.value);
				}
				if (planRes.status === "fulfilled") {
					setPlanStatus(planRes.value);
					setPlanDraft(planRes.value.content ?? "");
					setPlanDirty(false);
				}
				if (backgroundRes.status === "fulfilled") {
					setBackgroundStatus(backgroundRes.value);
				}
				if (lspRes.status === "fulfilled") {
					setLspStatus(lspRes.value);
				}
				if (mcpRes.status === "fulfilled") {
					setMcpStatus(mcpRes.value);
				}
				if (composerRes.status === "fulfilled") {
					setComposerStatus(composerRes.value);
				}

				if (!models?.length) {
					const modelResults = await Promise.allSettled([
						apiClient.getModels(),
						apiClient.getCurrentModel(),
					]);
					if (!active) return;
					if (modelResults[0].status === "fulfilled") {
						setAvailableModels(dedupeModels(modelResults[0].value ?? []));
					}
					if (modelResults[1].status === "fulfilled") {
						const model = modelResults[1].value;
						setSelectedModelId(model ? getModelKey(model) : "");
					}
				}

				if (hasSession) {
					const sessionResults = await Promise.allSettled([
						apiClient.getUiStatus(sessionKey),
						apiClient.getQueueStatus(sessionKey),
						apiClient.getZenMode(sessionKey),
					]);
					if (!active) return;
					if (sessionResults[0].status === "fulfilled") {
						const ui = sessionResults[0].value;
						setUiStatus((prev) => ({
							...prev,
							...ui,
						}));
					}
					if (sessionResults[1].status === "fulfilled") {
						setQueueMode(sessionResults[1].value.mode);
					}
					if (sessionResults[2].status === "fulfilled") {
						setUiStatus((prev) => ({
							...prev,
							zenMode: sessionResults[2].value.enabled,
						}));
					}
				} else {
					setUiStatus(DEFAULT_UI_STATUS);
					setQueueMode("all");
				}
			} catch (err) {
				if (!active) return;
				setError(
					err instanceof Error ? err.message : "Failed to load settings",
				);
			} finally {
				if (active) setLoading(false);
			}
		};

		load();

		(async () => {
			if (window.electron?.getTheme) {
				try {
					const theme = await window.electron.getTheme();
					if (active && theme) {
						setThemeMode(theme as ThemeMode);
					}
				} catch {
					// ignore
				}
			}
		})();

		return () => {
			active = false;
		};
	}, [open, sessionKey, hasSession, models?.length]);

	useEffect(() => {
		if (!composerStatus) return;
		const activeName = composerStatus.active?.name;
		if (activeName) {
			setSelectedComposer(activeName);
			return;
		}
		if (!selectedComposer && composerStatus.composers.length > 0) {
			setSelectedComposer(composerStatus.composers[0].name);
		}
	}, [composerStatus, selectedComposer]);

	const handleTimestampToggle = (event: ChangeEvent<HTMLInputElement>) => {
		onChange({
			...settings,
			showTimestamps: event.target.checked,
		});
	};

	const setDensity = (density: DensityMode) => {
		onChange({
			...settings,
			density,
		});
	};

	const setThinkingLevel = (level: ThinkingLevel) => {
		onChange({
			...settings,
			thinkingLevel: level,
		});
	};

	const updateTheme = async (mode: ThemeMode) => {
		setThemeMode(mode);
		await window.electron?.setTheme?.(mode);
	};

	const updateModel = async (modelId: string) => {
		setSelectedModelId(modelId);
		try {
			if (onModelChange) {
				await onModelChange(modelId);
			} else {
				await apiClient.setModel(modelId);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to update model");
		}
	};

	const updateMode = async (mode: string) => {
		setModeStatus((prev) => (prev ? { ...prev, mode } : { mode }));
		try {
			const res = await apiClient.setMode(mode);
			setModeStatus(res);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to update mode");
		}
	};

	const updateApproval = async (mode: ApprovalMode) => {
		setApprovalMode(mode);
		try {
			await apiClient.setApprovalMode(mode, sessionKey);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to update approval mode",
			);
		}
	};

	const updateQueueMode = async (mode: QueueMode) => {
		setQueueMode(mode);
		if (!hasSession) return;
		try {
			await apiClient.setQueueMode(mode, sessionKey);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to update queue mode",
			);
		}
	};

	const updateZen = async (enabled: boolean) => {
		setUiStatus((prev) => ({ ...prev, zenMode: enabled }));
		if (!hasSession) return;
		try {
			await apiClient.setZenMode(sessionKey, enabled);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to update zen");
		}
	};

	const updateCleanMode = async (mode: CleanMode) => {
		setUiStatus((prev) => ({ ...prev, cleanMode: mode }));
		if (!hasSession) return;
		try {
			await apiClient.setCleanMode(mode, sessionKey);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to update clean mode",
			);
		}
	};

	const updateFooterMode = async (mode: FooterMode) => {
		setUiStatus((prev) => ({ ...prev, footerMode: mode }));
		if (!hasSession) return;
		try {
			await apiClient.setFooterMode(mode, sessionKey);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to update footer mode",
			);
		}
	};

	const updateCompactTools = async (enabled: boolean) => {
		setUiStatus((prev) => ({ ...prev, compactTools: enabled }));
		if (!hasSession) return;
		try {
			await apiClient.setCompactTools(enabled, sessionKey);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to update compact tools",
			);
		}
	};

	const updateFramework = async (framework: string) => {
		setFrameworkId(framework);
		try {
			await apiClient.setFramework(
				framework === "none" ? null : framework,
				frameworkScope,
			);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to update framework",
			);
		}
	};

	const updateFrameworkScope = async (scope: "user" | "workspace") => {
		setFrameworkScope(scope);
		try {
			await apiClient.setFramework(
				frameworkId === "none" ? null : frameworkId,
				scope,
			);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to update framework",
			);
		}
	};

	const updateTelemetry = async (action: "on" | "off" | "reset") => {
		try {
			const res = await apiClient.setTelemetry(action);
			setTelemetryStatus(res.status);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to update telemetry",
			);
		}
	};

	const updateTraining = async (action: "on" | "off" | "reset") => {
		try {
			const res = await apiClient.setTraining(action);
			setTrainingStatus(res.status);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to update training",
			);
		}
	};

	const updateGuardianEnabled = async (enabled: boolean) => {
		setGuardianStatus((prev) =>
			prev
				? { ...prev, enabled, state: { ...prev.state, enabled } }
				: { enabled, state: { enabled } },
		);
		try {
			await apiClient.setGuardianEnabled(enabled);
			const refreshed = await apiClient.getGuardianStatus();
			setGuardianStatus(refreshed);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to update guardian",
			);
		}
	};

	const runGuardianNow = async () => {
		setGuardianRunning(true);
		try {
			const result = await apiClient.runGuardian();
			setGuardianStatus((prev) => {
				const nextState = prev?.state ?? { enabled: prev?.enabled ?? true };
				return {
					enabled: prev?.enabled ?? true,
					state: { ...nextState, lastRun: result },
				};
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : "Guardian run failed");
		} finally {
			setGuardianRunning(false);
		}
	};

	const refreshPlan = async () => {
		try {
			const status = await apiClient.getPlan();
			setPlanStatus(status);
			setPlanDraft(status.content ?? "");
			setPlanDirty(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to refresh plan");
		}
	};

	const startPlan = async () => {
		try {
			await apiClient.enterPlanMode(planName.trim() || undefined, sessionKey);
			setPlanName("");
			await refreshPlan();
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to start plan mode",
			);
		}
	};

	const exitPlan = async () => {
		try {
			await apiClient.exitPlanMode();
			await refreshPlan();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to exit plan mode");
		}
	};

	const savePlan = async () => {
		try {
			await apiClient.updatePlan(planDraft);
			await refreshPlan();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to update plan");
		}
	};

	const updateBackgroundNotifications = async (enabled: boolean) => {
		setBackgroundStatus((prev) =>
			prev
				? {
						...prev,
						settings: { ...prev.settings, notificationsEnabled: enabled },
					}
				: prev,
		);
		try {
			await apiClient.setBackgroundNotifications(enabled);
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: "Failed to update background notifications",
			);
		}
	};

	const updateBackgroundDetails = async (enabled: boolean) => {
		setBackgroundStatus((prev) =>
			prev
				? {
						...prev,
						settings: { ...prev.settings, statusDetailsEnabled: enabled },
					}
				: prev,
		);
		try {
			await apiClient.setBackgroundStatusDetails(enabled);
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: "Failed to update background details",
			);
		}
	};

	const refreshLspStatus = async () => {
		try {
			const status = await apiClient.getLspStatus();
			setLspStatus(status);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to load LSP status",
			);
		}
	};

	const handleLspAction = async (action: "start" | "stop" | "restart") => {
		try {
			if (action === "start") {
				await apiClient.startLsp();
			} else if (action === "stop") {
				await apiClient.stopLsp();
			} else {
				await apiClient.restartLsp();
			}
			await refreshLspStatus();
		} catch (err) {
			setError(err instanceof Error ? err.message : "LSP command failed");
		}
	};

	const detectLsp = async () => {
		try {
			const detections = await apiClient.detectLspServers();
			setLspDetections(detections.detections ?? []);
		} catch (err) {
			setError(err instanceof Error ? err.message : "LSP detection failed");
		}
	};

	const refreshMcpStatus = async () => {
		try {
			const status = await apiClient.getMcpStatus();
			setMcpStatus(status);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to load MCP status",
			);
		}
	};

	const refreshComposers = async () => {
		try {
			const status = await apiClient.getComposers();
			setComposerStatus(status);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to load composer profiles",
			);
		}
	};

	const activateComposer = async () => {
		if (!selectedComposer) return;
		try {
			await apiClient.activateComposer(selectedComposer);
			await refreshComposers();
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to activate composer",
			);
		}
	};

	const deactivateComposer = async () => {
		try {
			await apiClient.deactivateComposer();
			await refreshComposers();
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to deactivate composer",
			);
		}
	};

	const frameworkOptions = useMemo(() => {
		return [{ id: "none", summary: "No framework" }, ...frameworks];
	}, [frameworks]);

	const modelOptions = useMemo(() => {
		const list = availableModels.length ? availableModels : (models ?? []);
		return dedupeModels(list);
	}, [availableModels, models]);

	const formatTimestamp = (value?: number | string) => {
		if (!value) return "Unknown";
		const date = typeof value === "number" ? new Date(value) : new Date(value);
		if (Number.isNaN(date.getTime())) return "Unknown";
		return date.toLocaleString();
	};

	const formatDuration = (value?: number) => {
		if (!value || value <= 0) return "";
		if (value < 1000) return `${Math.round(value)}ms`;
		if (value < 60000) return `${(value / 1000).toFixed(1)}s`;
		return `${Math.round(value / 1000)}s`;
	};

	if (!open) return null;

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center">
			<button
				type="button"
				className="absolute inset-0 bg-black/50 z-40"
				onClick={onClose}
				title="Close settings"
			/>
			<div className="relative z-50 w-[760px] max-w-[92vw] max-h-[90vh] overflow-hidden rounded-2xl border border-line-subtle bg-bg-secondary shadow-[0_24px_64px_-20px_rgba(0,0,0,0.7)]">
				<div className="flex items-center justify-between px-5 py-4 border-b border-line-subtle">
					<div>
						<h2 className="text-sm font-semibold text-text-primary">
							Settings
						</h2>
						<p className="text-xs text-text-muted">
							Slash-command controls for this session.
						</p>
					</div>
					<button
						type="button"
						className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-tertiary/60 transition-colors"
						onClick={onClose}
						title="Close"
					>
						<svg
							aria-hidden="true"
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				</div>

				<div className="px-5 py-5 space-y-6 text-sm text-text-secondary overflow-y-auto max-h-[calc(90vh-96px)]">
					{error && (
						<div className="border border-error/40 bg-error/10 text-error px-3 py-2 rounded-lg text-xs">
							{error}
						</div>
					)}
					{loading && (
						<div className="text-xs text-text-tertiary">Loading settings…</div>
					)}

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
									value={themeMode}
									onChange={(event) =>
										updateTheme(event.target.value as ThemeMode)
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
									<div className="text-text-primary font-medium">
										Show timestamps
									</div>
									<div className="text-xs text-text-muted">
										Display message time in the chat header.
									</div>
								</div>
								<label className="inline-flex items-center gap-2 text-xs text-text-tertiary">
									<input
										type="checkbox"
										checked={settings.showTimestamps}
										onChange={handleTimestampToggle}
										className="h-4 w-4 rounded border-line-subtle bg-bg-tertiary text-accent focus:ring-accent"
									/>
									<span>{settings.showTimestamps ? "On" : "Off"}</span>
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
											settings.density === "comfortable"
												? "border-accent text-text-primary bg-bg-tertiary"
												: "border-line-subtle text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
										}`}
										onClick={() => setDensity("comfortable")}
									>
										Comfortable
									</button>
									<button
										type="button"
										className={`px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
											settings.density === "compact"
												? "border-accent text-text-primary bg-bg-tertiary"
												: "border-line-subtle text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
										}`}
										onClick={() => setDensity("compact")}
									>
										Compact
									</button>
								</div>
							</div>
						</div>
					</section>

					<section className="border border-line-subtle rounded-xl overflow-hidden">
						<div className="px-4 py-2 text-xs font-semibold text-text-tertiary border-b border-line-subtle uppercase tracking-wide">
							Model & Reasoning
						</div>
						<div className="p-4 space-y-4">
							<div className="flex items-center justify-between gap-4">
								<div>
									<div className="text-text-primary font-medium">Model</div>
									<div className="text-xs text-text-muted">
										Slash command: /model
									</div>
								</div>
								<select
									value={selectedModelId}
									onChange={(event) => updateModel(event.target.value)}
									className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary"
								>
									{modelOptions.length === 0 && (
										<option value="">No models detected</option>
									)}
									{modelOptions.map((model) => (
										<option key={getModelKey(model)} value={getModelKey(model)}>
											{model.name || model.id} · {model.provider}
										</option>
									))}
								</select>
							</div>

							<div className="flex items-center justify-between gap-4">
								<div>
									<div className="text-text-primary font-medium">
										Agent mode
									</div>
									<div className="text-xs text-text-muted">
										Slash command: /mode
									</div>
								</div>
								<select
									value={modeStatus?.mode ?? modeOptions[0]}
									onChange={(event) => updateMode(event.target.value)}
									className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary"
								>
									{modeOptions.map((mode) => (
										<option key={mode} value={mode}>
											{mode}
										</option>
									))}
								</select>
							</div>
							{modeStatus?.config?.description && (
								<div className="text-xs text-text-muted">
									{modeStatus.config.description}
								</div>
							)}

							<div className="flex items-center justify-between gap-4">
								<div>
									<div className="text-text-primary font-medium">
										Thinking level
									</div>
									<div className="text-xs text-text-muted">
										Controls reasoning depth for supported models.
									</div>
								</div>
								<select
									value={settings.thinkingLevel}
									onChange={(event) =>
										setThinkingLevel(event.target.value as ThinkingLevel)
									}
									className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary"
								>
									<option value="off">Off</option>
									<option value="minimal">Minimal</option>
									<option value="low">Low</option>
									<option value="medium">Medium</option>
									<option value="high">High</option>
									<option value="max">Max</option>
								</select>
							</div>
						</div>
					</section>

					<section className="border border-line-subtle rounded-xl overflow-hidden">
						<div className="px-4 py-2 text-xs font-semibold text-text-tertiary border-b border-line-subtle uppercase tracking-wide">
							Safety & Approvals
						</div>
						<div className="p-4 space-y-4">
							<div className="flex items-center justify-between gap-4">
								<div>
									<div className="text-text-primary font-medium">
										Approval mode
									</div>
									<div className="text-xs text-text-muted">
										Auto, prompt, or fail for tool use.
									</div>
								</div>
								<select
									value={approvalMode}
									onChange={(event) =>
										updateApproval(event.target.value as ApprovalMode)
									}
									className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary"
								>
									<option value="auto">Auto</option>
									<option value="prompt">Prompt</option>
									<option value="fail">Fail</option>
								</select>
							</div>

							<div className="flex items-center justify-between gap-4">
								<div>
									<div className="text-text-primary font-medium">Guardian</div>
									<div className="text-xs text-text-muted">
										Secrets scanning on writes and commits.
									</div>
								</div>
								<div className="flex items-center gap-2">
									<label className="inline-flex items-center gap-2 text-xs text-text-tertiary">
										<input
											type="checkbox"
											checked={guardianStatus?.enabled ?? true}
											onChange={(event) =>
												updateGuardianEnabled(event.target.checked)
											}
											className="h-4 w-4 rounded border-line-subtle bg-bg-tertiary text-accent focus:ring-accent"
										/>
										<span>{guardianStatus?.enabled ? "On" : "Off"}</span>
									</label>
									<button
										type="button"
										className="px-3 py-2 rounded-lg border border-line-subtle text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
										onClick={runGuardianNow}
										disabled={guardianRunning}
									>
										{guardianRunning ? "Running…" : "Run now"}
									</button>
								</div>
							</div>
							{guardianStatus?.state?.lastRun && (
								<div className="text-xs text-text-muted">
									Last run {guardianStatus.state.lastRun.status} ·{" "}
									{guardianStatus.state.lastRun.summary} ·{" "}
									{formatDuration(guardianStatus.state.lastRun.durationMs)}·{" "}
									{formatTimestamp(guardianStatus.state.lastRun.startedAt)}
								</div>
							)}
						</div>
					</section>

					<section className="border border-line-subtle rounded-xl overflow-hidden">
						<div className="px-4 py-2 text-xs font-semibold text-text-tertiary border-b border-line-subtle uppercase tracking-wide">
							Planning
						</div>
						<div className="p-4 space-y-4">
							<div className="flex items-center justify-between gap-4">
								<div>
									<div className="text-text-primary font-medium">Plan mode</div>
									<div className="text-xs text-text-muted">
										Slash command: /plan
									</div>
								</div>
								<div className="flex items-center gap-2">
									{planStatus?.state?.active ? (
										<button
											type="button"
											className="px-3 py-2 rounded-lg border border-line-subtle text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
											onClick={exitPlan}
										>
											Exit plan
										</button>
									) : (
										<button
											type="button"
											className="px-3 py-2 rounded-lg border border-line-subtle text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
											onClick={startPlan}
										>
											Start plan
										</button>
									)}
								</div>
							</div>
							{!planStatus?.state?.active && (
								<div className="flex items-center justify-between gap-4">
									<div className="text-xs text-text-muted">
										Optional plan name
									</div>
									<input
										type="text"
										value={planName}
										onChange={(event) => setPlanName(event.target.value)}
										placeholder="Feature rollout plan"
										className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary w-64"
									/>
								</div>
							)}
							{planStatus?.state?.active && (
								<div className="space-y-3">
									<textarea
										value={planDraft}
										onChange={(event) => {
											setPlanDraft(event.target.value);
											setPlanDirty(true);
										}}
										rows={6}
										className="w-full bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary"
									/>
									<div className="flex items-center justify-between gap-4">
										<button
											type="button"
											className="px-3 py-2 rounded-lg border border-line-subtle text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60 disabled:opacity-50"
											onClick={savePlan}
											disabled={!planDirty}
										>
											Save plan
										</button>
										<div className="text-xs text-text-muted">
											{planStatus?.state?.filePath
												? planStatus.state.filePath
												: "Plan file not created yet"}
										</div>
									</div>
								</div>
							)}
						</div>
					</section>

					<section className="border border-line-subtle rounded-xl overflow-hidden">
						<div className="px-4 py-2 text-xs font-semibold text-text-tertiary border-b border-line-subtle uppercase tracking-wide">
							Session Controls
						</div>
						<div className="p-4 space-y-4">
							{!hasSession && (
								<div className="text-xs text-text-muted">
									Start a session to enable session-scoped settings.
								</div>
							)}
							<div className="flex items-center justify-between gap-4">
								<div>
									<div className="text-text-primary font-medium">Zen mode</div>
									<div className="text-xs text-text-muted">
										Reduce UI clutter.
									</div>
								</div>
								<label className="inline-flex items-center gap-2 text-xs text-text-tertiary">
									<input
										type="checkbox"
										disabled={!hasSession}
										checked={uiStatus.zenMode}
										onChange={(event) => updateZen(event.target.checked)}
										className="h-4 w-4 rounded border-line-subtle bg-bg-tertiary text-accent focus:ring-accent"
									/>
									<span>{uiStatus.zenMode ? "On" : "Off"}</span>
								</label>
							</div>

							<div className="flex items-center justify-between gap-4">
								<div>
									<div className="text-text-primary font-medium">
										Clean mode
									</div>
									<div className="text-xs text-text-muted">
										Clean up output formatting.
									</div>
								</div>
								<select
									disabled={!hasSession}
									value={uiStatus.cleanMode}
									onChange={(event) =>
										updateCleanMode(event.target.value as CleanMode)
									}
									className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary disabled:opacity-50"
								>
									<option value="off">Off</option>
									<option value="soft">Soft</option>
									<option value="aggressive">Aggressive</option>
								</select>
							</div>

							<div className="flex items-center justify-between gap-4">
								<div>
									<div className="text-text-primary font-medium">
										Footer mode
									</div>
									<div className="text-xs text-text-muted">
										Status footer density.
									</div>
								</div>
								<select
									disabled={!hasSession}
									value={uiStatus.footerMode}
									onChange={(event) =>
										updateFooterMode(event.target.value as FooterMode)
									}
									className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary disabled:opacity-50"
								>
									<option value="ensemble">Ensemble</option>
									<option value="solo">Solo</option>
								</select>
							</div>

							<div className="flex items-center justify-between gap-4">
								<div>
									<div className="text-text-primary font-medium">
										Compact tools
									</div>
									<div className="text-xs text-text-muted">
										Reduce tool output cards.
									</div>
								</div>
								<label className="inline-flex items-center gap-2 text-xs text-text-tertiary">
									<input
										type="checkbox"
										disabled={!hasSession}
										checked={uiStatus.compactTools}
										onChange={(event) =>
											updateCompactTools(event.target.checked)
										}
										className="h-4 w-4 rounded border-line-subtle bg-bg-tertiary text-accent focus:ring-accent"
									/>
									<span>{uiStatus.compactTools ? "On" : "Off"}</span>
								</label>
							</div>

							<div className="flex items-center justify-between gap-4">
								<div>
									<div className="text-text-primary font-medium">
										Queue mode
									</div>
									<div className="text-xs text-text-muted">
										One or all prompts queued.
									</div>
								</div>
								<select
									disabled={!hasSession}
									value={queueMode}
									onChange={(event) =>
										updateQueueMode(event.target.value as QueueMode)
									}
									className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary disabled:opacity-50"
								>
									<option value="one">One</option>
									<option value="all">All</option>
								</select>
							</div>
						</div>
					</section>

					<section className="border border-line-subtle rounded-xl overflow-hidden">
						<div className="px-4 py-2 text-xs font-semibold text-text-tertiary border-b border-line-subtle uppercase tracking-wide">
							Framework
						</div>
						<div className="p-4 space-y-4">
							<div className="flex items-center justify-between gap-4">
								<div>
									<div className="text-text-primary font-medium">
										Default framework
									</div>
									<div className="text-xs text-text-muted">
										Slash command: /framework
									</div>
								</div>
								<select
									disabled={frameworkLocked}
									value={frameworkId}
									onChange={(event) => updateFramework(event.target.value)}
									className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary disabled:opacity-50"
								>
									{frameworkOptions.map((framework) => (
										<option key={framework.id} value={framework.id}>
											{framework.id === "none" ? "None" : framework.id}
										</option>
									))}
								</select>
							</div>

							<div className="flex items-center justify-between gap-4">
								<div>
									<div className="text-text-primary font-medium">Scope</div>
									<div className="text-xs text-text-muted">
										User or workspace default.
									</div>
								</div>
								<div className="flex items-center gap-2">
									<button
										type="button"
										disabled={frameworkLocked}
										className={`px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
											frameworkScope === "user"
												? "border-accent text-text-primary bg-bg-tertiary"
												: "border-line-subtle text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
										}`}
										onClick={() => updateFrameworkScope("user")}
									>
										User
									</button>
									<button
										type="button"
										disabled={frameworkLocked}
										className={`px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
											frameworkScope === "workspace"
												? "border-accent text-text-primary bg-bg-tertiary"
												: "border-line-subtle text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
										}`}
										onClick={() => updateFrameworkScope("workspace")}
									>
										Workspace
									</button>
								</div>
							</div>
							{frameworkLocked && (
								<div className="text-xs text-text-muted">
									Framework is locked by policy.
								</div>
							)}
						</div>
					</section>

					<section className="border border-line-subtle rounded-xl overflow-hidden">
						<div className="px-4 py-2 text-xs font-semibold text-text-tertiary border-b border-line-subtle uppercase tracking-wide">
							Background Tasks
						</div>
						<div className="p-4 space-y-4">
							<div className="flex items-center justify-between gap-4">
								<div>
									<div className="text-text-primary font-medium">
										Notifications
									</div>
									<div className="text-xs text-text-muted">
										Slash command: /background notify
									</div>
								</div>
								<label className="inline-flex items-center gap-2 text-xs text-text-tertiary">
									<input
										type="checkbox"
										checked={
											backgroundStatus?.settings.notificationsEnabled ?? false
										}
										onChange={(event) =>
											updateBackgroundNotifications(event.target.checked)
										}
										className="h-4 w-4 rounded border-line-subtle bg-bg-tertiary text-accent focus:ring-accent"
									/>
									<span>
										{backgroundStatus?.settings.notificationsEnabled
											? "On"
											: "Off"}
									</span>
								</label>
							</div>
							<div className="flex items-center justify-between gap-4">
								<div>
									<div className="text-text-primary font-medium">
										Status details
									</div>
									<div className="text-xs text-text-muted">
										Slash command: /background details
									</div>
								</div>
								<label className="inline-flex items-center gap-2 text-xs text-text-tertiary">
									<input
										type="checkbox"
										checked={
											backgroundStatus?.settings.statusDetailsEnabled ?? false
										}
										onChange={(event) =>
											updateBackgroundDetails(event.target.checked)
										}
										className="h-4 w-4 rounded border-line-subtle bg-bg-tertiary text-accent focus:ring-accent"
									/>
									<span>
										{backgroundStatus?.settings.statusDetailsEnabled
											? "On"
											: "Off"}
									</span>
								</label>
							</div>
							<div className="text-xs text-text-muted">
								Running: {backgroundStatus?.snapshot?.running ?? 0} · Failed:{" "}
								{backgroundStatus?.snapshot?.failed ?? 0} · Total:{" "}
								{backgroundStatus?.snapshot?.total ?? 0}
							</div>
						</div>
					</section>

					<section className="border border-line-subtle rounded-xl overflow-hidden">
						<div className="px-4 py-2 text-xs font-semibold text-text-tertiary border-b border-line-subtle uppercase tracking-wide">
							Tools & Runtime
						</div>
						<div className="p-4 space-y-5">
							<div className="space-y-2">
								<div className="flex items-center justify-between gap-4">
									<div>
										<div className="text-text-primary font-medium">
											LSP servers
										</div>
										<div className="text-xs text-text-muted">
											Slash command: /lsp
										</div>
									</div>
									<div className="flex items-center gap-2">
										<button
											type="button"
											className="px-2.5 py-1.5 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
											onClick={() => handleLspAction("start")}
										>
											Start
										</button>
										<button
											type="button"
											className="px-2.5 py-1.5 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
											onClick={() => handleLspAction("stop")}
										>
											Stop
										</button>
										<button
											type="button"
											className="px-2.5 py-1.5 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
											onClick={() => handleLspAction("restart")}
										>
											Restart
										</button>
										<button
											type="button"
											className="px-2.5 py-1.5 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
											onClick={detectLsp}
										>
											Detect
										</button>
									</div>
								</div>
								<div className="text-xs text-text-muted">
									Enabled: {lspStatus?.enabled ? "Yes" : "No"} · Autostart:{" "}
									{lspStatus?.autostart ? "Yes" : "No"} · Servers:{" "}
									{lspStatus?.servers?.length ?? 0}
								</div>
								{lspStatus?.servers?.length ? (
									<div className="grid grid-cols-1 gap-2">
										{lspStatus.servers.map((server) => (
											<div
												key={server.id}
												className="flex items-center justify-between text-xs text-text-muted"
											>
												<span>{server.id}</span>
												<span>
													{server.fileCount} files · {server.diagnosticCount}{" "}
													diag
												</span>
											</div>
										))}
									</div>
								) : (
									<div className="text-xs text-text-muted">
										No active LSP servers.
									</div>
								)}
								{lspDetections.length > 0 && (
									<div className="text-xs text-text-muted">
										Detected: {lspDetections.map((d) => d.serverId).join(", ")}
									</div>
								)}
							</div>

							<div className="space-y-2">
								<div className="flex items-center justify-between gap-4">
									<div>
										<div className="text-text-primary font-medium">
											MCP servers
										</div>
										<div className="text-xs text-text-muted">
											Slash command: /mcp
										</div>
									</div>
									<button
										type="button"
										className="px-2.5 py-1.5 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
										onClick={refreshMcpStatus}
									>
										Refresh
									</button>
								</div>
								{mcpStatus?.servers?.length ? (
									<div className="grid grid-cols-1 gap-2">
										{mcpStatus.servers.map((server) => (
											<div
												key={server.name}
												className="flex items-center justify-between text-xs text-text-muted"
											>
												<span>{server.name}</span>
												<span>
													{server.connected ? "Connected" : "Offline"} ·{" "}
													{server.tools ?? 0} tools
												</span>
											</div>
										))}
									</div>
								) : (
									<div className="text-xs text-text-muted">
										No MCP servers configured.
									</div>
								)}
							</div>

							<div className="space-y-2">
								<div className="flex items-center justify-between gap-4">
									<div>
										<div className="text-text-primary font-medium">
											Composer profiles
										</div>
										<div className="text-xs text-text-muted">
											Slash command: /composer
										</div>
									</div>
									<div className="flex items-center gap-2">
										<button
											type="button"
											className="px-2.5 py-1.5 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
											onClick={refreshComposers}
										>
											Refresh
										</button>
									</div>
								</div>
								<div className="flex items-center justify-between gap-4">
									<select
										value={selectedComposer}
										onChange={(event) =>
											setSelectedComposer(event.target.value)
										}
										className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary w-64"
									>
										{composerStatus?.composers?.length ? (
											composerStatus.composers.map((composer) => (
												<option key={composer.name} value={composer.name}>
													{composer.name}
												</option>
											))
										) : (
											<option value="">No profiles</option>
										)}
									</select>
									<div className="flex items-center gap-2">
										<button
											type="button"
											className="px-2.5 py-1.5 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
											onClick={activateComposer}
											disabled={!selectedComposer}
										>
											Activate
										</button>
										<button
											type="button"
											className="px-2.5 py-1.5 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
											onClick={deactivateComposer}
										>
											Deactivate
										</button>
									</div>
								</div>
								<div className="text-xs text-text-muted">
									Active: {composerStatus?.active?.name ?? "none"}
								</div>
							</div>
						</div>
					</section>

					<section className="border border-line-subtle rounded-xl overflow-hidden">
						<div className="px-4 py-2 text-xs font-semibold text-text-tertiary border-b border-line-subtle uppercase tracking-wide">
							Telemetry & Training
						</div>
						<div className="p-4 space-y-4">
							<div className="flex items-center justify-between gap-4">
								<div>
									<div className="text-text-primary font-medium">Telemetry</div>
									<div className="text-xs text-text-muted">
										Status: {telemetryStatus?.enabled ? "On" : "Off"}
									</div>
								</div>
								<div className="flex items-center gap-2">
									<button
										type="button"
										className="px-3 py-2 rounded-lg border border-line-subtle text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
										onClick={() => updateTelemetry("on")}
									>
										Enable
									</button>
									<button
										type="button"
										className="px-3 py-2 rounded-lg border border-line-subtle text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
										onClick={() => updateTelemetry("off")}
									>
										Disable
									</button>
									<button
										type="button"
										className="px-3 py-2 rounded-lg border border-line-subtle text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
										onClick={() => updateTelemetry("reset")}
									>
										Reset
									</button>
								</div>
							</div>

							<div className="flex items-center justify-between gap-4">
								<div>
									<div className="text-text-primary font-medium">
										Training data
									</div>
									<div className="text-xs text-text-muted">
										Preference: {trainingStatus?.preference ?? "unknown"}
									</div>
								</div>
								<div className="flex items-center gap-2">
									<button
										type="button"
										className="px-3 py-2 rounded-lg border border-line-subtle text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
										onClick={() => updateTraining("on")}
									>
										Opt-in
									</button>
									<button
										type="button"
										className="px-3 py-2 rounded-lg border border-line-subtle text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
										onClick={() => updateTraining("off")}
									>
										Opt-out
									</button>
									<button
										type="button"
										className="px-3 py-2 rounded-lg border border-line-subtle text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
										onClick={() => updateTraining("reset")}
									>
										Reset
									</button>
								</div>
							</div>
						</div>
					</section>
				</div>
			</div>
		</div>
	);
}
