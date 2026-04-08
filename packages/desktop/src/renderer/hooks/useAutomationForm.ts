import { useCallback, useEffect, useMemo, useState } from "react";
import {
	type ScheduleKind,
	dayOptions,
	formatDateLabel,
	formatLocalDateTimeInput,
	formatTimeLabel,
	parseCronSchedule,
} from "../components/Automations/automation-form-utils";
import type {
	AutomationCreateInput,
	AutomationUpdateInput,
} from "../lib/api-client";
import { apiClient } from "../lib/api-client";
import type { AutomationTask, Model, ThinkingLevel } from "../lib/types";

export interface AutomationTemplate {
	id: string;
	name: string;
	description: string;
	prompt: string;
	scheduleKind: ScheduleKind;
	dailyTime?: string;
	weeklyTime?: string;
	weeklyDays?: number[];
	thinkingLevel?: ThinkingLevel;
	contextPaths?: string[];
	contextFolders?: string[];
}

type UseAutomationFormOptions = {
	currentSessionId: string | null;
	currentModel: Model | null;
	createAutomation: (
		input: AutomationCreateInput,
	) => Promise<AutomationTask | null>;
	updateAutomation: (
		id: string,
		input: AutomationUpdateInput,
	) => Promise<AutomationTask | null>;
	onSaved: (automationId: string) => void;
};

type SchedulePreview = {
	schedule: string | null;
	runAt: string | null;
	label: string;
};

export function useAutomationForm({
	currentSessionId,
	currentModel,
	createAutomation,
	updateAutomation,
	onSaved,
}: UseAutomationFormOptions) {
	const [editingId, setEditingId] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [prompt, setPrompt] = useState("");
	const [scheduleKind, setScheduleKind] = useState<ScheduleKind>("weekly");
	const [onceDateTime, setOnceDateTime] = useState("");
	const [dailyTime, setDailyTime] = useState("09:00");
	const [weeklyTime, setWeeklyTime] = useState("09:00");
	const [weeklyDays, setWeeklyDays] = useState<number[]>([1]);
	const [cronExpression, setCronExpression] = useState("0 9 * * 1");
	const [timezone, setTimezone] = useState(
		Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
	);
	const [sessionMode, setSessionMode] = useState<"reuse" | "new">("reuse");
	const [sessionId, setSessionId] = useState<string | null>(currentSessionId);
	const [contextPaths, setContextPaths] = useState<string[]>([]);
	const [contextInput, setContextInput] = useState("");
	const [contextFolders, setContextFolders] = useState<string[]>([]);
	const [contextFolderInput, setContextFolderInput] = useState("");
	const [runWindowEnabled, setRunWindowEnabled] = useState(false);
	const [runWindowStart, setRunWindowStart] = useState("09:00");
	const [runWindowEnd, setRunWindowEnd] = useState("17:00");
	const [runWindowDays, setRunWindowDays] = useState<number[]>([1, 2, 3, 4, 5]);
	const [exclusiveRun, setExclusiveRun] = useState(false);
	const [notifyOnSuccess, setNotifyOnSuccess] = useState(true);
	const [notifyOnFailure, setNotifyOnFailure] = useState(true);
	const [model, setModel] = useState<string | undefined>(
		currentModel ? `${currentModel.provider}:${currentModel.id}` : undefined,
	);
	const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("off");
	const [previewNextRun, setPreviewNextRun] = useState<string | null>(null);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [previewTimezoneValid, setPreviewTimezoneValid] = useState(true);

	const systemTimezone = useMemo(
		() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
		[],
	);

	useEffect(() => {
		if (!editingId && currentSessionId) {
			setSessionId(currentSessionId);
		}
	}, [currentSessionId, editingId]);

	useEffect(() => {
		if (!editingId && currentModel) {
			setModel(`${currentModel.provider}:${currentModel.id}`);
		}
	}, [currentModel, editingId]);

	const handleResetForm = useCallback(() => {
		setEditingId(null);
		setName("");
		setPrompt("");
		setScheduleKind("weekly");
		setOnceDateTime("");
		setDailyTime("09:00");
		setWeeklyTime("09:00");
		setWeeklyDays([1]);
		setCronExpression("0 9 * * 1");
		setTimezone(systemTimezone);
		setSessionMode("reuse");
		setSessionId(currentSessionId);
		setContextPaths([]);
		setContextInput("");
		setContextFolders([]);
		setContextFolderInput("");
		setRunWindowEnabled(false);
		setRunWindowStart("09:00");
		setRunWindowEnd("17:00");
		setRunWindowDays([1, 2, 3, 4, 5]);
		setExclusiveRun(false);
		setNotifyOnSuccess(true);
		setNotifyOnFailure(true);
		setModel(
			currentModel ? `${currentModel.provider}:${currentModel.id}` : undefined,
		);
		setThinkingLevel("off");
		setPreviewNextRun(null);
		setPreviewError(null);
		setPreviewLoading(false);
		setPreviewTimezoneValid(true);
	}, [currentModel, currentSessionId, systemTimezone]);

	const handleEditAutomation = useCallback(
		(automation: AutomationTask) => {
			setEditingId(automation.id);
			setName(automation.name);
			setPrompt(automation.prompt);
			setScheduleKind(
				automation.scheduleKind || (automation.schedule ? "cron" : "once"),
			);
			setTimezone(automation.timezone || "UTC");
			setSessionMode(automation.sessionMode || "reuse");
			setSessionId(automation.sessionId || currentSessionId);
			setContextPaths(automation.contextPaths || []);
			setContextFolders(automation.contextFolders || []);
			setModel(automation.model || undefined);
			setThinkingLevel(automation.thinkingLevel || "off");
			setExclusiveRun(automation.exclusive ?? false);
			setNotifyOnSuccess(automation.notifyOnSuccess ?? true);
			setNotifyOnFailure(automation.notifyOnFailure ?? true);

			if (automation.runWindow) {
				setRunWindowEnabled(true);
				setRunWindowStart(automation.runWindow.start);
				setRunWindowEnd(automation.runWindow.end);
				setRunWindowDays(automation.runWindow.days ?? []);
			} else {
				setRunWindowEnabled(false);
				setRunWindowStart("09:00");
				setRunWindowEnd("17:00");
				setRunWindowDays([1, 2, 3, 4, 5]);
			}

			if (automation.scheduleKind === "once") {
				setOnceDateTime(
					formatLocalDateTimeInput(
						automation.runAt || automation.nextRun || "",
					),
				);
			} else if (automation.scheduleKind === "daily") {
				setDailyTime(automation.scheduleTime || "09:00");
			} else if (automation.scheduleKind === "weekly") {
				setWeeklyTime(automation.scheduleTime || "09:00");
				setWeeklyDays(automation.scheduleDays || [1]);
			} else if (automation.scheduleKind === "cron") {
				setCronExpression(
					automation.cronExpression || automation.schedule || "0 9 * * 1",
				);
			} else if (automation.schedule) {
				const parsed = parseCronSchedule(automation.schedule);
				if (parsed?.days && parsed.days.length > 0) {
					setScheduleKind("weekly");
					setWeeklyDays(parsed.days);
					setWeeklyTime(parsed.time);
				} else if (parsed?.time) {
					setScheduleKind("daily");
					setDailyTime(parsed.time);
				} else {
					setScheduleKind("cron");
					setCronExpression(automation.schedule);
				}
			}
		},
		[currentSessionId],
	);

	const handleApplyTemplate = useCallback(
		(template: AutomationTemplate) => {
			setEditingId(null);
			setName(template.name);
			setPrompt(template.prompt);
			setScheduleKind(template.scheduleKind);
			setOnceDateTime("");
			setDailyTime(template.dailyTime ?? "09:00");
			setWeeklyTime(template.weeklyTime ?? "09:00");
			setWeeklyDays(template.weeklyDays ?? [1]);
			setCronExpression("0 9 * * 1");
			setTimezone(systemTimezone);
			setSessionMode("reuse");
			setSessionId(currentSessionId);
			setContextPaths(template.contextPaths ?? []);
			setContextInput("");
			setContextFolders(template.contextFolders ?? []);
			setContextFolderInput("");
			setRunWindowEnabled(false);
			setRunWindowStart("09:00");
			setRunWindowEnd("17:00");
			setRunWindowDays([1, 2, 3, 4, 5]);
			setExclusiveRun(false);
			setNotifyOnSuccess(true);
			setNotifyOnFailure(true);
			setThinkingLevel(template.thinkingLevel ?? "off");
		},
		[currentSessionId, systemTimezone],
	);

	const handleInsertToken = useCallback((token: string) => {
		setPrompt((prev) => {
			if (!prev.trim()) return token;
			if (prev.endsWith(" ") || prev.endsWith("\n")) return `${prev}${token}`;
			return `${prev} ${token}`;
		});
	}, []);

	const buildSchedule = useCallback((): SchedulePreview => {
		if (scheduleKind === "once") {
			const date = onceDateTime ? new Date(onceDateTime) : null;
			const runAt =
				date && !Number.isNaN(date.getTime()) ? date.toISOString() : "";
			return {
				schedule: null,
				runAt,
				label: runAt ? `One-time · ${formatDateLabel(runAt)}` : "One-time",
			};
		}
		if (scheduleKind === "daily") {
			const [hour, minute] = dailyTime.split(":");
			const schedule = `${minute} ${hour} * * *`;
			return {
				schedule,
				runAt: null,
				label: `Daily · ${formatTimeLabel(dailyTime)}`,
			};
		}
		if (scheduleKind === "weekly") {
			const [hour, minute] = weeklyTime.split(":");
			const days = (weeklyDays.length > 0 ? weeklyDays : [1]).slice();
			const sortedDays = days.sort((a, b) => a - b);
			const schedule = `${minute} ${hour} * * ${sortedDays.join(",")}`;
			const daysLabel = sortedDays
				.map((day) => dayOptions.find((option) => option.value === day)?.label)
				.filter(Boolean)
				.join(", ");
			return {
				schedule,
				runAt: null,
				label: `Weekly · ${daysLabel || "Mon"} · ${formatTimeLabel(weeklyTime)}`,
			};
		}
		const schedule = cronExpression.trim();
		return {
			schedule,
			runAt: null,
			label: `Cron · ${schedule}`,
		};
	}, [
		scheduleKind,
		onceDateTime,
		dailyTime,
		weeklyTime,
		weeklyDays,
		cronExpression,
	]);

	const schedulePreview = useMemo(() => buildSchedule(), [buildSchedule]);

	useEffect(() => {
		let active = true;
		if (!schedulePreview.schedule && !schedulePreview.runAt) {
			setPreviewNextRun(null);
			setPreviewError(null);
			setPreviewTimezoneValid(true);
			setPreviewLoading(false);
			return () => undefined;
		}

		setPreviewLoading(true);
		const timeout = setTimeout(() => {
			apiClient
				.previewAutomation({
					schedule: schedulePreview.schedule,
					runAt: schedulePreview.runAt,
					timezone,
				})
				.then((response) => {
					if (!active) return;
					setPreviewNextRun(response.nextRun);
					setPreviewTimezoneValid(response.timezoneValid);
					setPreviewError(response.error ?? null);
				})
				.catch((error) => {
					if (!active) return;
					setPreviewError(
						error instanceof Error ? error.message : "Failed to preview run.",
					);
				})
				.finally(() => {
					if (active) setPreviewLoading(false);
				});
		}, 250);

		return () => {
			active = false;
			clearTimeout(timeout);
		};
	}, [schedulePreview.schedule, schedulePreview.runAt, timezone]);

	const handleSubmit = useCallback(async () => {
		if (!name.trim() || !prompt.trim()) return;
		const schedule = buildSchedule();
		const runWindow = runWindowEnabled
			? {
					start: runWindowStart,
					end: runWindowEnd,
					days: runWindowDays.length > 0 ? runWindowDays : undefined,
				}
			: null;
		const payload: AutomationCreateInput = {
			name: name.trim(),
			prompt: prompt.trim(),
			schedule: schedule.schedule,
			runAt:
				scheduleKind === "once" ? (schedule.runAt ?? undefined) : undefined,
			scheduleLabel: schedule.label,
			scheduleKind,
			scheduleTime:
				scheduleKind === "daily"
					? dailyTime
					: scheduleKind === "weekly"
						? weeklyTime
						: undefined,
			scheduleDays: scheduleKind === "weekly" ? weeklyDays : undefined,
			cronExpression: scheduleKind === "cron" ? cronExpression : undefined,
			timezone,
			enabled: true,
			sessionMode,
			sessionId: sessionMode === "reuse" ? sessionId : null,
			contextPaths,
			contextFolders,
			runWindow,
			exclusive: exclusiveRun,
			notifyOnSuccess,
			notifyOnFailure,
			model,
			thinkingLevel,
		};

		if (editingId) {
			const updated = await updateAutomation(
				editingId,
				payload as AutomationUpdateInput,
			);
			if (!updated) return;
			onSaved(updated.id);
			handleResetForm();
			return;
		}

		const created = await createAutomation(payload);
		if (!created) return;
		onSaved(created.id);
		handleResetForm();
	}, [
		name,
		prompt,
		buildSchedule,
		runWindowEnabled,
		runWindowStart,
		runWindowEnd,
		runWindowDays,
		scheduleKind,
		dailyTime,
		weeklyTime,
		weeklyDays,
		cronExpression,
		timezone,
		sessionMode,
		sessionId,
		contextPaths,
		contextFolders,
		exclusiveRun,
		notifyOnSuccess,
		notifyOnFailure,
		model,
		thinkingLevel,
		editingId,
		updateAutomation,
		createAutomation,
		onSaved,
		handleResetForm,
	]);

	const handleAddContextPath = useCallback(() => {
		if (!contextInput.trim()) return;
		const next = contextInput.trim();
		setContextPaths((prev) => (prev.includes(next) ? prev : [...prev, next]));
		setContextInput("");
	}, [contextInput]);

	const handleAddContextFolder = useCallback(() => {
		if (!contextFolderInput.trim()) return;
		const next = contextFolderInput.trim();
		setContextFolders((prev) => (prev.includes(next) ? prev : [...prev, next]));
		setContextFolderInput("");
	}, [contextFolderInput]);

	const handlePickContextFile = useCallback(async () => {
		if (!window.electron?.openFile) return;
		const filePath = await window.electron.openFile({
			title: "Add context file",
		});
		if (!filePath) return;
		setContextPaths((prev) =>
			prev.includes(filePath) ? prev : [...prev, filePath],
		);
	}, []);

	const handlePickContextFolder = useCallback(async () => {
		if (!window.electron?.openDirectory) return;
		const folderPath = await window.electron.openDirectory({
			title: "Add context folder",
		});
		if (!folderPath) return;
		setContextFolders((prev) =>
			prev.includes(folderPath) ? prev : [...prev, folderPath],
		);
	}, []);

	const isSubmitDisabled =
		!name.trim() ||
		!prompt.trim() ||
		(scheduleKind === "once" && !onceDateTime) ||
		(scheduleKind === "cron" && !cronExpression.trim()) ||
		Boolean(previewError) ||
		previewLoading;

	return {
		contextFolderInput,
		contextFolders,
		contextInput,
		contextPaths,
		cronExpression,
		dailyTime,
		editingId,
		exclusiveRun,
		handleAddContextFolder,
		handleAddContextPath,
		handleApplyTemplate,
		handleEditAutomation,
		handleInsertToken,
		handlePickContextFile,
		handlePickContextFolder,
		handleResetForm,
		handleSubmit,
		isSubmitDisabled,
		model,
		name,
		notifyOnFailure,
		notifyOnSuccess,
		onceDateTime,
		previewError,
		previewLoading,
		previewNextRun,
		previewTimezoneValid,
		prompt,
		runWindowDays,
		runWindowEnabled,
		runWindowEnd,
		runWindowStart,
		scheduleKind,
		schedulePreview,
		sessionId,
		sessionMode,
		setContextFolderInput,
		setContextFolders,
		setContextInput,
		setContextPaths,
		setCronExpression,
		setDailyTime,
		setExclusiveRun,
		setModel,
		setName,
		setNotifyOnFailure,
		setNotifyOnSuccess,
		setOnceDateTime,
		setPrompt,
		setRunWindowDays,
		setRunWindowEnabled,
		setRunWindowEnd,
		setRunWindowStart,
		setScheduleKind,
		setSessionId,
		setSessionMode,
		setThinkingLevel,
		setTimezone,
		systemTimezone,
		setWeeklyDays,
		setWeeklyTime,
		thinkingLevel,
		timezone,
		weeklyDays,
		weeklyTime,
	};
}
