/**
 * SettingsModal Component
 *
 * Comprehensive settings panel for desktop preferences.
 */

import { useCallback, useEffect, useState } from "react";
import {
	type ApprovalMode,
	type BackgroundStatus,
	type CleanMode,
	type ComposerStatus,
	type FooterMode,
	type FrameworkSummary,
	type GuardianStatus,
	type LspStatus,
	type McpAuthPresetAddRequest,
	type McpAuthPresetRemoveRequest,
	type McpAuthPresetUpdateRequest,
	type McpServerAddRequest,
	type McpServerRemoveRequest,
	type McpServerUpdateRequest,
	type McpStatus,
	type ModeStatus,
	type PlanStatus,
	type QueueMode,
	type TelemetryStatus,
	type TrainingStatus,
	type UiStatus,
	apiClient,
} from "../../lib/api-client";
import { dedupeModels, getModelKey } from "../../lib/model-utils";
import type { Model, ThinkingLevel } from "../../lib/types";
import { AppearanceSection } from "./AppearanceSection";
import { BackgroundTasksSection } from "./BackgroundTasksSection";
import { FrameworkSection } from "./FrameworkSection";
import { MemorySection } from "./MemorySection";
import {
	DEFAULT_MODE_OPTIONS,
	ModelReasoningSection,
	normalizeModeOptions,
} from "./ModelReasoningSection";
import { PlanningSection } from "./PlanningSection";
import { SafetyApprovalsSection } from "./SafetyApprovalsSection";
import { SessionBehaviorSection } from "./SessionBehaviorSection";
import {
	type TelemetryTrainingAction,
	TelemetryTrainingSection,
} from "./TelemetryTrainingSection";
import { TerminalUiSection } from "./TerminalUiSection";
import {
	type LspAction,
	type LspDetection,
	ToolsRuntimeSection,
	resolveComposerSelection,
} from "./ToolsRuntimeSection";

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
	const [showCliOnlyControls, setShowCliOnlyControls] = useState(false);
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
	const [lspDetections, setLspDetections] = useState<LspDetection[]>([]);
	const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null);
	const [expandedMcpServer, setExpandedMcpServer] = useState<string | null>(
		null,
	);
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
						const zenEnabled = sessionResults[2].value.enabled;
						setUiStatus((prev) => ({
							...prev,
							zenMode: zenEnabled,
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
		const nextSelection = resolveComposerSelection(
			composerStatus,
			selectedComposer,
		);
		if (nextSelection !== selectedComposer) {
			setSelectedComposer(nextSelection);
		}
	}, [composerStatus, selectedComposer]);

	const setShowTimestamps = (enabled: boolean) => {
		onChange({
			...settings,
			showTimestamps: enabled,
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

	const updateTelemetry = async (action: TelemetryTrainingAction) => {
		try {
			const res = await apiClient.setTelemetry(action);
			setTelemetryStatus(res.status);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to update telemetry",
			);
		}
	};

	const updateTraining = async (action: TelemetryTrainingAction) => {
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

	const listMemoryTopics = useCallback(async (targetSessionId?: string) => {
		return await apiClient.listMemoryTopics(targetSessionId);
	}, []);

	const listMemoryTopic = useCallback(
		async (topic: string, targetSessionId?: string) => {
			return await apiClient.listMemoryTopic(topic, targetSessionId);
		},
		[],
	);

	const searchMemory = useCallback(
		async (query: string, limit = 10, targetSessionId?: string) => {
			return await apiClient.searchMemory(query, limit, targetSessionId);
		},
		[],
	);

	const getRecentMemories = useCallback(
		async (limit = 10, targetSessionId?: string) => {
			return await apiClient.getRecentMemories(limit, targetSessionId);
		},
		[],
	);

	const getMemoryStats = useCallback(async (targetSessionId?: string) => {
		return await apiClient.getMemoryStats(targetSessionId);
	}, []);

	const saveMemory = useCallback(
		async (
			topic: string,
			content: string,
			tags?: string[],
			targetSessionId?: string,
		) => {
			return await apiClient.saveMemory(topic, content, tags, targetSessionId);
		},
		[],
	);

	const deleteMemory = useCallback(async (id?: string, topic?: string) => {
		return await apiClient.deleteMemory(id, topic);
	}, []);

	const clearMemory = useCallback(async (force = false) => {
		return await apiClient.clearMemory(force);
	}, []);

	const handlePlanDraftChange = (draft: string) => {
		setPlanDraft(draft);
		setPlanDirty(true);
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

	const handleLspAction = async (action: LspAction) => {
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

	const toggleMcpServer = (name: string) => {
		setExpandedMcpServer((prev) => (prev === name ? null : name));
	};

	const searchMcpRegistry = useCallback(async (query: string) => {
		return await apiClient.searchMcpRegistry(query);
	}, []);

	const importMcpRegistry = async (input: {
		query: string;
		name?: string;
		scope?: "local" | "project" | "user";
		url?: string;
		transport?: "http" | "sse";
	}) => {
		const result = await apiClient.importMcpRegistry(input);
		const status = await apiClient.getMcpStatus();
		setMcpStatus(status);
		setExpandedMcpServer(result.name);
		return result;
	};

	const addMcpServer = async (input: McpServerAddRequest) => {
		const result = await apiClient.addMcpServer(input);
		const status = await apiClient.getMcpStatus();
		setMcpStatus(status);
		setExpandedMcpServer(result.name);
		return result;
	};

	const addMcpAuthPreset = async (input: McpAuthPresetAddRequest) => {
		const result = await apiClient.addMcpAuthPreset(input);
		const status = await apiClient.getMcpStatus();
		setMcpStatus(status);
		return result;
	};

	const removeMcpServer = async (input: McpServerRemoveRequest) => {
		const result = await apiClient.removeMcpServer(input);
		const status = await apiClient.getMcpStatus();
		setMcpStatus(status);
		setExpandedMcpServer((prev) => {
			if (prev !== input.name) {
				return prev;
			}
			return result.fallback?.name ?? null;
		});
		return result;
	};

	const setMcpProjectApproval = async (input: {
		name: string;
		decision: "approved" | "denied";
	}) => {
		const result = await apiClient.setMcpProjectApproval(input);
		const status = await apiClient.getMcpStatus();
		setMcpStatus(status);
		setExpandedMcpServer(result.name);
		return result;
	};

	const removeMcpAuthPreset = async (input: McpAuthPresetRemoveRequest) => {
		const result = await apiClient.removeMcpAuthPreset(input);
		const status = await apiClient.getMcpStatus();
		setMcpStatus(status);
		return result;
	};

	const updateMcpServer = async (input: McpServerUpdateRequest) => {
		const result = await apiClient.updateMcpServer(input);
		const status = await apiClient.getMcpStatus();
		setMcpStatus(status);
		setExpandedMcpServer(result.name);
		return result;
	};

	const updateMcpAuthPreset = async (input: McpAuthPresetUpdateRequest) => {
		const result = await apiClient.updateMcpAuthPreset(input);
		const status = await apiClient.getMcpStatus();
		setMcpStatus(status);
		return result;
	};

	const readMcpResource = async (server: string, uri: string) => {
		return await apiClient.readMcpResource(server, uri);
	};

	const getMcpPrompt = async (
		server: string,
		name: string,
		args?: Record<string, string>,
	) => {
		return await apiClient.getMcpPrompt(server, name, args);
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
							Desktop preferences plus runtime controls. Toggle CLI-only
							settings when needed.
						</p>
					</div>
					<div className="flex items-center gap-2">
						<button
							type="button"
							className="px-3 py-2 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
							onClick={() => setShowCliOnlyControls((prev) => !prev)}
							title="Show terminal-only settings"
						>
							{showCliOnlyControls ? "Hide CLI-only" : "Show CLI-only"}
						</button>
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

					<AppearanceSection
						themeMode={themeMode}
						showTimestamps={settings.showTimestamps}
						density={settings.density}
						onUpdateTheme={updateTheme}
						onToggleTimestamps={setShowTimestamps}
						onSetDensity={setDensity}
					/>

					<ModelReasoningSection
						availableModels={availableModels}
						fallbackModels={models ?? []}
						selectedModelId={selectedModelId}
						modeStatus={modeStatus}
						modeOptions={modeOptions}
						thinkingLevel={settings.thinkingLevel}
						onUpdateModel={updateModel}
						onUpdateMode={updateMode}
						onThinkingLevelChange={setThinkingLevel}
					/>

					<SafetyApprovalsSection
						approvalMode={approvalMode}
						guardianStatus={guardianStatus}
						guardianRunning={guardianRunning}
						onUpdateApproval={updateApproval}
						onUpdateGuardianEnabled={updateGuardianEnabled}
						onRunGuardianNow={runGuardianNow}
					/>

					<PlanningSection
						planStatus={planStatus}
						planDraft={planDraft}
						planDirty={planDirty}
						planName={planName}
						onPlanNameChange={setPlanName}
						onPlanDraftChange={handlePlanDraftChange}
						onStartPlan={startPlan}
						onExitPlan={exitPlan}
						onSavePlan={savePlan}
					/>

					<MemorySection
						sessionId={sessionId}
						onListMemoryTopics={listMemoryTopics}
						onListMemoryTopic={listMemoryTopic}
						onSearchMemory={searchMemory}
						onGetRecentMemories={getRecentMemories}
						onGetMemoryStats={getMemoryStats}
						onSaveMemory={saveMemory}
						onDeleteMemory={deleteMemory}
						onClearMemory={clearMemory}
					/>

					<SessionBehaviorSection
						hasSession={hasSession}
						queueMode={queueMode}
						onUpdateQueueMode={updateQueueMode}
					/>

					<FrameworkSection
						frameworks={frameworks}
						frameworkId={frameworkId}
						frameworkScope={frameworkScope}
						frameworkLocked={frameworkLocked}
						onUpdateFramework={updateFramework}
						onUpdateFrameworkScope={updateFrameworkScope}
					/>

					<BackgroundTasksSection
						backgroundStatus={backgroundStatus}
						onUpdateNotifications={updateBackgroundNotifications}
						onUpdateStatusDetails={updateBackgroundDetails}
					/>

					<ToolsRuntimeSection
						lspStatus={lspStatus}
						lspDetections={lspDetections}
						onLspAction={handleLspAction}
						onDetectLsp={detectLsp}
						mcpStatus={mcpStatus}
						expandedMcpServer={expandedMcpServer}
						onToggleMcpServer={toggleMcpServer}
						onRefreshMcpStatus={refreshMcpStatus}
						onSearchMcpRegistry={searchMcpRegistry}
						onImportMcpRegistry={importMcpRegistry}
						onAddMcpServer={addMcpServer}
						onAddMcpAuthPreset={addMcpAuthPreset}
						onUpdateMcpServer={updateMcpServer}
						onUpdateMcpAuthPreset={updateMcpAuthPreset}
						onRemoveMcpServer={removeMcpServer}
						onSetMcpProjectApproval={setMcpProjectApproval}
						onRemoveMcpAuthPreset={removeMcpAuthPreset}
						onReadMcpResource={readMcpResource}
						onGetMcpPrompt={getMcpPrompt}
						composerStatus={composerStatus}
						selectedComposer={selectedComposer}
						onSelectedComposerChange={setSelectedComposer}
						onRefreshComposers={refreshComposers}
						onActivateComposer={activateComposer}
						onDeactivateComposer={deactivateComposer}
					/>

					<TelemetryTrainingSection
						telemetryStatus={telemetryStatus}
						trainingStatus={trainingStatus}
						updateTelemetry={updateTelemetry}
						updateTraining={updateTraining}
					/>

					{showCliOnlyControls && (
						<TerminalUiSection
							uiStatus={uiStatus}
							hasSession={hasSession}
							onUpdateZen={updateZen}
							onUpdateCleanMode={updateCleanMode}
							onUpdateFooterMode={updateFooterMode}
							onUpdateCompactTools={updateCompactTools}
						/>
					)}
				</div>
			</div>
		</div>
	);
}
