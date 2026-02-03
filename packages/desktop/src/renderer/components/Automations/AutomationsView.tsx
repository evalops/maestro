import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAutomations } from "../../hooks/useAutomations";
import type {
	AutomationCreateInput,
	AutomationUpdateInput,
} from "../../lib/api-client";
import { apiClient } from "../../lib/api-client";
import type {
	AutomationTask,
	Model,
	SessionSummary,
	ThinkingLevel,
} from "../../lib/types";

type AutomationViewProps = {
	sessions: SessionSummary[];
	currentSessionId: string | null;
	models: Model[];
	currentModel: Model | null;
	onOpenSession: (sessionId: string) => void;
};

type ScheduleKind = "once" | "daily" | "weekly" | "cron";

type AutomationToast = {
	id: string;
	title: string;
	message: string;
	status: "success" | "failure";
	sessionId?: string;
};

const dayOptions = [
	{ label: "Sun", value: 0 },
	{ label: "Mon", value: 1 },
	{ label: "Tue", value: 2 },
	{ label: "Wed", value: 3 },
	{ label: "Thu", value: 4 },
	{ label: "Fri", value: 5 },
	{ label: "Sat", value: 6 },
];

const thinkingOptions: ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"max",
];

const promptTokenOptions = [
	{
		label: "Date",
		token: "{{date}}",
		description: "Local date",
	},
	{
		label: "DateTime",
		token: "{{datetime}}",
		description: "Local date + time",
	},
	{
		label: "Time",
		token: "{{time}}",
		description: "Local time",
	},
	{
		label: "Timezone",
		token: "{{timezone}}",
		description: "Resolved timezone",
	},
	{
		label: "Automation",
		token: "{{automation_name}}",
		description: "Automation name",
	},
	{
		label: "Run Count",
		token: "{{run_count}}",
		description: "Total runs",
	},
	{
		label: "Last Run",
		token: "{{last_run_at}}",
		description: "Last run timestamp",
	},
	{
		label: "Last Status",
		token: "{{last_status}}",
		description: "Last run status",
	},
	{
		label: "Last Error",
		token: "{{last_error}}",
		description: "Last run error",
	},
	{
		label: "Last Output",
		token: "{{last_output}}",
		description: "Last run output",
	},
	{
		label: "Schedule",
		token: "{{schedule_label}}",
		description: "Schedule summary",
	},
	{
		label: "Next Run",
		token: "{{next_run_at}}",
		description: "Next scheduled run",
	},
	{
		label: "Workspace",
		token: "{{workspace}}",
		description: "Current workspace",
	},
];

const automationTemplates = [
	{
		id: "morning-review",
		name: "Morning Review",
		description: "Daily repo pulse check and TODO scan.",
		prompt:
			"Review git status, recent commits, and TODOs. Summarize priorities for {{date}}.",
		scheduleKind: "daily" as const,
		dailyTime: "09:00",
		thinkingLevel: "low" as ThinkingLevel,
	},
	{
		id: "weekly-digest",
		name: "Weekly Digest",
		description: "Weekly engineering recap with next steps.",
		prompt:
			"Summarize changes since last run ({{last_run_at}}) and draft next actions.",
		scheduleKind: "weekly" as const,
		weeklyTime: "09:30",
		weeklyDays: [1],
		thinkingLevel: "medium" as ThinkingLevel,
	},
	{
		id: "nightly-check",
		name: "Nightly Quality Check",
		description: "Run tests/lint and summarize regressions.",
		prompt:
			"Run the relevant test and lint commands. Report failures and quick fixes.",
		scheduleKind: "daily" as const,
		dailyTime: "19:00",
		thinkingLevel: "low" as ThinkingLevel,
	},
];

function formatLocalDateTimeInput(value: string | undefined) {
	if (!value) return "";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	const pad = (num: number) => `${num}`.padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
		date.getDate(),
	)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatTimeLabel(value: string) {
	if (!value) return "—";
	const [hourStr, minuteStr] = value.split(":");
	const hours = Number.parseInt(hourStr || "0", 10);
	const minutes = Number.parseInt(minuteStr || "0", 10);
	const date = new Date();
	date.setHours(hours);
	date.setMinutes(minutes);
	return date.toLocaleTimeString(undefined, {
		hour: "numeric",
		minute: "2-digit",
	});
}

function formatDateLabel(value?: string | null) {
	if (!value) return "—";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "—";
	return date.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

function formatRelativeTime(value?: string | null) {
	if (!value) return "—";
	const date = new Date(value);
	const diff = date.getTime() - Date.now();
	const abs = Math.abs(diff);
	const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
	if (abs < 60_000) {
		const seconds = Math.round(diff / 1000);
		return rtf.format(seconds, "second");
	}
	if (abs < 3_600_000) {
		const minutes = Math.round(diff / 60_000);
		return rtf.format(minutes, "minute");
	}
	if (abs < 86_400_000) {
		const hours = Math.round(diff / 3_600_000);
		return rtf.format(hours, "hour");
	}
	const days = Math.round(diff / 86_400_000);
	return rtf.format(days, "day");
}

function formatDuration(value?: number | null) {
	if (!value || !Number.isFinite(value)) return "—";
	if (value < 1000) return `${value}ms`;
	const seconds = value / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	const remaining = Math.round(seconds % 60);
	return `${minutes}m ${remaining}s`;
}

function parseCronSchedule(schedule: string | null | undefined) {
	if (!schedule) return null;
	const parts = schedule.trim().split(/\s+/);
	if (parts.length !== 5) return null;
	const [minute, hour, _dom, _month, dow] = parts;
	if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return null;
	if (!minute || !hour) return null;
	const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
	const days =
		dow && dow !== "*"
			? dow
					.split(",")
					.flatMap((entry) => {
						if (entry.includes("-")) {
							const [startRaw, endRaw] = entry.split("-");
							const start = Number(startRaw);
							const end = Number(endRaw);
							if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
							return Array.from(
								{ length: end - start + 1 },
								(_, i) => start + i,
							);
						}
						const value = Number(entry);
						return Number.isFinite(value) ? [value] : [];
					})
					.filter((day) => Number.isFinite(day))
			: null;
	return { time, days };
}

export function AutomationsView({
	sessions,
	currentSessionId,
	models,
	currentModel,
	onOpenSession,
}: AutomationViewProps) {
	const {
		automations,
		loading,
		refreshAutomations,
		createAutomation,
		updateAutomation,
		deleteAutomation,
		runAutomation,
	} = useAutomations();

	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [filter, setFilter] = useState("");

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
	const [notificationsEnabled, setNotificationsEnabled] = useState(false);
	const [toasts, setToasts] = useState<AutomationToast[]>([]);
	const seenRunsRef = useRef<Record<string, string>>({});

	const systemTimezone = useMemo(
		() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
		[],
	);
	const timezoneOptions = useMemo(() => {
		const supportedValuesOf = (
			Intl as typeof Intl & {
				supportedValuesOf?: (key: "timeZone") => string[];
			}
		).supportedValuesOf;
		if (typeof supportedValuesOf === "function") {
			return supportedValuesOf("timeZone");
		}
		return [
			"UTC",
			"America/Los_Angeles",
			"America/New_York",
			"Europe/London",
			"Europe/Berlin",
			"Asia/Tokyo",
		];
	}, []);

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

	useEffect(() => {
		const interval = setInterval(() => {
			void refreshAutomations();
		}, 15000);
		return () => clearInterval(interval);
	}, [refreshAutomations]);

	useEffect(() => {
		let active = true;
		const loadNotifications = async () => {
			try {
				const status = await apiClient.getBackgroundStatus();
				if (!active) return;
				setNotificationsEnabled(status.settings?.notificationsEnabled ?? false);
			} catch (error) {
				console.error("Failed to load notification settings:", error);
			}
		};
		void loadNotifications();
		const interval = setInterval(loadNotifications, 30000);
		return () => {
			active = false;
			clearInterval(interval);
		};
	}, []);

	useEffect(() => {
		if (!selectedId && automations.length > 0) {
			setSelectedId(automations[0]!.id);
		}
	}, [automations, selectedId]);

	const selectedAutomation = useMemo(
		() => automations.find((item) => item.id === selectedId) || null,
		[automations, selectedId],
	);

	const filteredAutomations = useMemo(() => {
		const query = filter.trim().toLowerCase();
		if (!query) return automations;
		return automations.filter(
			(item) =>
				item.name.toLowerCase().includes(query) ||
				item.prompt.toLowerCase().includes(query),
		);
	}, [automations, filter]);

	const automationCounts = useMemo(() => {
		const enabled = automations.filter((item) => item.enabled).length;
		const running = automations.filter((item) => item.running).length;
		return {
			total: automations.length,
			enabled,
			paused: automations.length - enabled,
			running,
		};
	}, [automations]);

	const addToast = useCallback((toast: AutomationToast) => {
		setToasts((prev) => {
			const next = [...prev, toast];
			return next.slice(-4);
		});
		window.setTimeout(() => {
			setToasts((prev) => prev.filter((item) => item.id !== toast.id));
		}, 6000);
	}, []);

	useEffect(() => {
		if (automations.length === 0) return;
		const seen = seenRunsRef.current;
		for (const automation of automations) {
			const latest = automation.runHistory?.[0];
			if (!latest) continue;
			if (!seen[automation.id]) {
				seen[automation.id] = latest.id;
				continue;
			}
			if (seen[automation.id] === latest.id) continue;
			seen[automation.id] = latest.id;
			if (latest.status === "skipped") continue;
			if (latest.status === "success" && automation.notifyOnSuccess === false) {
				continue;
			}
			if (latest.status === "failure" && automation.notifyOnFailure === false) {
				continue;
			}

			const title =
				latest.status === "success"
					? "Automation complete"
					: "Automation failed";
			const message = `${automation.name} · ${formatDuration(
				latest.durationMs,
			)}`;
			addToast({
				id: `${automation.id}-${latest.id}`,
				title,
				message,
				status: latest.status === "success" ? "success" : "failure",
				sessionId: latest.sessionId,
			});

			if (notificationsEnabled && window.electron?.showNotification) {
				const body =
					latest.status === "success"
						? `${automation.name} finished successfully.`
						: `${automation.name} failed. Open run details for the error.`;
				window.electron.showNotification(title, body);
			}
		}
	}, [automations, notificationsEnabled, addToast]);

	const handleResetForm = () => {
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
	};

	const handleEditAutomation = (automation: AutomationTask) => {
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
				formatLocalDateTimeInput(automation.runAt || automation.nextRun || ""),
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
	};

	const handleApplyTemplate = (
		template: (typeof automationTemplates)[number],
	) => {
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
		setThinkingLevel(template.thinkingLevel ?? "off");
	};

	const handleInsertToken = (token: string) => {
		setPrompt((prev) => {
			if (!prev.trim()) return token;
			if (prev.endsWith(" ") || prev.endsWith("\n")) return `${prev}${token}`;
			return `${prev} ${token}`;
		});
	};

	const buildSchedule = useCallback(() => {
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
				label: `Daily · ${formatTimeLabel(dailyTime)}`,
			};
		}
		if (scheduleKind === "weekly") {
			const [hour, minute] = weeklyTime.split(":");
			const days = (weeklyDays.length > 0 ? weeklyDays : [1]).slice();
			const sortedDays = days.sort((a, b) => a - b);
			const schedule = `${minute} ${hour} * * ${sortedDays.join(",")}`;
			const daysLabel = sortedDays
				.map((day) => dayOptions.find((d) => d.value === day)?.label)
				.filter(Boolean)
				.join(", ");
			return {
				schedule,
				label: `Weekly · ${daysLabel || "Mon"} · ${formatTimeLabel(weeklyTime)}`,
			};
		}
		const schedule = cronExpression.trim();
		return {
			schedule,
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

		const runAt = schedulePreview.runAt ?? null;
		setPreviewLoading(true);
		const timeout = setTimeout(() => {
			apiClient
				.previewAutomation({
					schedule: schedulePreview.schedule,
					runAt,
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

	const handleSubmit = async () => {
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
			runAt: scheduleKind === "once" ? schedule.runAt : undefined,
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
			if (updated) {
				setSelectedId(updated.id);
				setEditingId(null);
			}
		} else {
			const created = await createAutomation(payload);
			if (created) {
				setSelectedId(created.id);
			}
		}
		handleResetForm();
	};

	const handleAddContextPath = () => {
		if (!contextInput.trim()) return;
		const next = contextInput.trim();
		setContextPaths((prev) => (prev.includes(next) ? prev : [...prev, next]));
		setContextInput("");
	};

	const handleAddContextFolder = () => {
		if (!contextFolderInput.trim()) return;
		const next = contextFolderInput.trim();
		setContextFolders((prev) => (prev.includes(next) ? prev : [...prev, next]));
		setContextFolderInput("");
	};

	const handlePickContextFile = async () => {
		if (!window.electron?.openFile) return;
		const filePath = await window.electron.openFile({
			title: "Add context file",
		});
		if (!filePath) return;
		setContextPaths((prev) =>
			prev.includes(filePath) ? prev : [...prev, filePath],
		);
	};

	const handlePickContextFolder = async () => {
		if (!window.electron?.openDirectory) return;
		const folderPath = await window.electron.openDirectory({
			title: "Add context folder",
		});
		if (!folderPath) return;
		setContextFolders((prev) =>
			prev.includes(folderPath) ? prev : [...prev, folderPath],
		);
	};

	const isSubmitDisabled =
		!name.trim() ||
		!prompt.trim() ||
		(scheduleKind === "once" && !onceDateTime) ||
		(scheduleKind === "cron" && !cronExpression.trim()) ||
		Boolean(previewError) ||
		previewLoading;
	const sectionCardClass =
		"rounded-2xl border border-border-subtle bg-bg-secondary/40 p-4";

	return (
		<div className="flex-1 overflow-hidden">
			{toasts.length > 0 && (
				<div className="fixed top-20 right-6 z-50 space-y-3">
					{toasts.map((toast) => (
						<div
							key={toast.id}
							className={`rounded-2xl border px-4 py-3 shadow-xl backdrop-blur ${
								toast.status === "success"
									? "border-success/30 bg-bg-tertiary/90"
									: "border-error/40 bg-error/10"
							}`}
						>
							<div className="flex items-start justify-between gap-3">
								<div>
									<div className="text-sm font-semibold text-text-primary">
										{toast.title}
									</div>
									<div className="text-xs text-text-muted mt-1">
										{toast.message}
									</div>
								</div>
								<button
									type="button"
									className="text-text-tertiary hover:text-text-primary"
									onClick={() =>
										setToasts((prev) =>
											prev.filter((item) => item.id !== toast.id),
										)
									}
								>
									×
								</button>
							</div>
							{toast.sessionId && (
								<button
									type="button"
									className="btn-secondary w-full mt-3"
									onClick={() => onOpenSession(toast.sessionId!)}
								>
									Open session
								</button>
							)}
						</div>
					))}
				</div>
			)}
			<div className="h-full overflow-y-auto px-6 py-6">
				<div className="flex items-start justify-between gap-4 mb-6">
					<div>
						<h2 className="text-2xl font-semibold text-text-primary">
							Automations
						</h2>
						<p className="text-sm text-text-muted mt-1">
							Schedule the agent to run with the right context, even when you
							are away.
						</p>
					</div>
					<button
						type="button"
						onClick={handleResetForm}
						className="btn-secondary text-sm"
					>
						New Automation
					</button>
				</div>

				<div className="grid grid-cols-1 xl:grid-cols-[1.05fr_0.95fr] gap-6">
					<div className="space-y-6">
						<div className="card p-5">
							<div className="flex items-center justify-between mb-4">
								<h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
									Active Automations
								</h3>
								<span className="badge-accent">
									{automationCounts.total} total
								</span>
							</div>
							<div className="space-y-3 mb-4">
								<input
									className="input"
									placeholder="Search automations..."
									value={filter}
									onChange={(event) => setFilter(event.target.value)}
								/>
								<div className="flex flex-wrap gap-2 text-xs text-text-muted">
									<span>{automationCounts.enabled} enabled</span>
									<span>•</span>
									<span>{automationCounts.paused} paused</span>
									{automationCounts.running > 0 && (
										<>
											<span>•</span>
											<span>{automationCounts.running} running</span>
										</>
									)}
								</div>
							</div>
							{loading ? (
								<div className="space-y-3">
									<div className="h-16 rounded-xl shimmer" />
									<div className="h-16 rounded-xl shimmer" />
								</div>
							) : filteredAutomations.length === 0 ? (
								<div className="text-sm text-text-muted">
									{automations.length === 0
										? "No automations yet. Build one on the right."
										: "No automations match this search."}
								</div>
							) : (
								<div className="space-y-3">
									{filteredAutomations.map((automation) => {
										const isActive = automation.id === selectedId;
										const statusLabel = automation.running
											? "Running"
											: automation.enabled
												? "Enabled"
												: "Paused";
										const statusStyle = automation.running
											? "badge-accent"
											: automation.enabled
												? "badge-success"
												: "badge bg-bg-tertiary text-text-muted";
										return (
											<button
												type="button"
												key={automation.id}
												className={`w-full text-left rounded-2xl border px-4 py-4 transition-all ${
													isActive
														? "border-accent/40 bg-bg-tertiary/50 shadow-[0_10px_30px_-20px_rgba(20,184,166,0.6)]"
														: "border-border-subtle bg-bg-secondary/40 hover:bg-bg-secondary/70"
												}`}
												onClick={() => setSelectedId(automation.id)}
											>
												<div className="flex items-start justify-between gap-3">
													<div>
														<div className="text-base font-semibold text-text-primary">
															{automation.name}
														</div>
														<div className="text-xs text-text-muted mt-1">
															{automation.scheduleLabel ||
																automation.schedule ||
																"One-time"}
														</div>
													</div>
													<span className={statusStyle}>{statusLabel}</span>
												</div>
												<div className="mt-3 grid grid-cols-2 gap-3 text-xs text-text-muted">
													<div>
														<div className="text-[10px] uppercase tracking-wide text-text-tertiary">
															Next Run
														</div>
														<div className="text-text-secondary">
															{automation.nextRun
																? `${formatDateLabel(
																		automation.nextRun,
																	)} · ${formatRelativeTime(automation.nextRun)}`
																: "—"}
														</div>
													</div>
													<div>
														<div className="text-[10px] uppercase tracking-wide text-text-tertiary">
															Last Run
														</div>
														<div className="text-text-secondary">
															{automation.lastRunAt
																? `${formatDateLabel(
																		automation.lastRunAt,
																	)} · ${automation.lastRunStatus || "—"}`
																: "—"}
														</div>
													</div>
												</div>
												<div className="mt-4 flex flex-wrap items-center gap-2">
													<button
														type="button"
														className="btn-ghost text-xs"
														onClick={(event) => {
															event.stopPropagation();
															void runAutomation(automation.id);
														}}
													>
														Run now
													</button>
													<button
														type="button"
														className="btn-ghost text-xs"
														onClick={(event) => {
															event.stopPropagation();
															void updateAutomation(automation.id, {
																enabled: !automation.enabled,
															});
														}}
													>
														{automation.enabled ? "Pause" : "Resume"}
													</button>
													<button
														type="button"
														className="btn-ghost text-xs"
														onClick={(event) => {
															event.stopPropagation();
															handleEditAutomation(automation);
														}}
													>
														Edit
													</button>
													<button
														type="button"
														className="btn-ghost text-xs text-error"
														onClick={(event) => {
															event.stopPropagation();
															void deleteAutomation(automation.id);
														}}
													>
														Delete
													</button>
												</div>
											</button>
										);
									})}
								</div>
							)}
						</div>
					</div>

					<div className="space-y-6">
						<div className="card p-5">
							<div className="flex items-center justify-between mb-4">
								<h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
									{editingId ? "Edit Automation" : "New Automation"}
								</h3>
								{editingId && (
									<button
										type="button"
										className="text-xs text-text-muted hover:text-text-primary"
										onClick={handleResetForm}
									>
										Cancel edit
									</button>
								)}
							</div>

							<div className="space-y-4">
								<div className={sectionCardClass}>
									<div className="flex items-start justify-between gap-3">
										<div>
											<div className="text-xs uppercase tracking-wide text-text-tertiary">
												Templates
											</div>
											<div className="text-xs text-text-muted mt-1">
												Start from a proven routine.
											</div>
										</div>
									</div>
									<div className="mt-3 grid gap-2 md:grid-cols-3">
										{automationTemplates.map((template) => (
											<button
												key={template.id}
												type="button"
												className="rounded-xl border border-border-subtle bg-bg-secondary/40 px-3 py-3 text-left transition hover:border-border-default hover:bg-bg-secondary/70"
												onClick={() => handleApplyTemplate(template)}
											>
												<div className="text-sm font-semibold text-text-primary">
													{template.name}
												</div>
												<div className="text-xs text-text-muted mt-1">
													{template.description}
												</div>
											</button>
										))}
									</div>
								</div>

								<div className={sectionCardClass}>
									<div className="text-xs uppercase tracking-wide text-text-tertiary">
										Basics
									</div>
									<div className="mt-3 space-y-3">
										<div>
											<label
												htmlFor="automation-name"
												className="text-xs uppercase tracking-wide text-text-tertiary"
											>
												Name
											</label>
											<input
												id="automation-name"
												className="input mt-2"
												placeholder="Weekly status sync"
												value={name}
												onChange={(event) => setName(event.target.value)}
											/>
										</div>

										<div>
											<label
												htmlFor="automation-prompt"
												className="text-xs uppercase tracking-wide text-text-tertiary"
											>
												Prompt
											</label>
											<textarea
												id="automation-prompt"
												className="input mt-2 h-28 resize-none"
												placeholder="Summarize the latest changes and open pull requests."
												value={prompt}
												onChange={(event) => setPrompt(event.target.value)}
											/>
											<div className="mt-3 flex flex-wrap gap-2">
												{promptTokenOptions.map((token) => (
													<button
														key={token.token}
														type="button"
														className="badge bg-bg-tertiary text-text-secondary hover:text-text-primary"
														title={token.description}
														onClick={() => handleInsertToken(token.token)}
													>
														{token.label}
													</button>
												))}
											</div>
											<div className="text-[11px] text-text-muted mt-2">
												Tokens are replaced at run time. Hover to see details.
											</div>
										</div>
									</div>
								</div>

								<div className={sectionCardClass}>
									<div className="flex items-start justify-between gap-3">
										<div>
											<div className="text-xs uppercase tracking-wide text-text-tertiary">
												Schedule
											</div>
											<div className="text-xs text-text-muted mt-1">
												Define when the automation runs.
											</div>
										</div>
									</div>
									<div className="mt-3 space-y-4">
										<div className="grid grid-cols-2 gap-3">
											<div>
												<label
													htmlFor="automation-schedule"
													className="text-xs uppercase tracking-wide text-text-tertiary"
												>
													Schedule
												</label>
												<select
													id="automation-schedule"
													className="input mt-2"
													value={scheduleKind}
													onChange={(event) =>
														setScheduleKind(event.target.value as ScheduleKind)
													}
												>
													<option value="once">One-time</option>
													<option value="daily">Daily</option>
													<option value="weekly">Weekly</option>
													<option value="cron">Cron</option>
												</select>
											</div>
											<div>
												<label
													htmlFor="automation-timezone"
													className="text-xs uppercase tracking-wide text-text-tertiary"
												>
													Timezone
												</label>
												<div className="mt-2 flex gap-2">
													<input
														id="automation-timezone"
														className="input"
														list="automation-timezones"
														value={timezone}
														onChange={(event) =>
															setTimezone(event.target.value)
														}
														placeholder="America/Los_Angeles"
													/>
													<button
														type="button"
														className="btn-secondary text-xs"
														onClick={() => setTimezone(systemTimezone)}
													>
														Local
													</button>
												</div>
												<datalist id="automation-timezones">
													{timezoneOptions.map((tz) => (
														<option key={tz} value={tz} />
													))}
												</datalist>
											</div>
										</div>

										{scheduleKind === "once" && (
											<div>
												<label
													htmlFor="automation-run-at"
													className="text-xs uppercase tracking-wide text-text-tertiary"
												>
													Run At
												</label>
												<input
													id="automation-run-at"
													type="datetime-local"
													className="input mt-2"
													value={onceDateTime}
													onChange={(event) =>
														setOnceDateTime(event.target.value)
													}
												/>
											</div>
										)}

										{scheduleKind === "daily" && (
											<div>
												<label
													htmlFor="automation-daily-time"
													className="text-xs uppercase tracking-wide text-text-tertiary"
												>
													Time
												</label>
												<input
													id="automation-daily-time"
													type="time"
													className="input mt-2"
													value={dailyTime}
													onChange={(event) => setDailyTime(event.target.value)}
												/>
											</div>
										)}

										{scheduleKind === "weekly" && (
											<div className="space-y-3">
												<div>
													<div className="text-xs uppercase tracking-wide text-text-tertiary">
														Days
													</div>
													<div className="mt-2 flex flex-wrap gap-2 text-[11px] text-text-muted">
														<button
															type="button"
															className="btn-ghost text-[11px]"
															onClick={() => setWeeklyDays([1, 2, 3, 4, 5])}
														>
															Weekdays
														</button>
														<button
															type="button"
															className="btn-ghost text-[11px]"
															onClick={() => setWeeklyDays([0, 6])}
														>
															Weekends
														</button>
														<button
															type="button"
															className="btn-ghost text-[11px]"
															onClick={() =>
																setWeeklyDays(
																	dayOptions.map((day) => day.value),
																)
															}
														>
															Every day
														</button>
													</div>
													<div className="mt-2 flex flex-wrap gap-2">
														{dayOptions.map((day) => {
															const selected = weeklyDays.includes(day.value);
															return (
																<button
																	key={day.value}
																	type="button"
																	className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
																		selected
																			? "border-accent bg-accent/15 text-accent"
																			: "border-border-subtle text-text-muted hover:border-border-default"
																	}`}
																	onClick={() => {
																		setWeeklyDays((prev) =>
																			prev.includes(day.value)
																				? prev.filter(
																						(item) => item !== day.value,
																					)
																				: [...prev, day.value],
																		);
																	}}
																>
																	{day.label}
																</button>
															);
														})}
													</div>
												</div>
												<div>
													<label
														htmlFor="automation-weekly-time"
														className="text-xs uppercase tracking-wide text-text-tertiary"
													>
														Time
													</label>
													<input
														id="automation-weekly-time"
														type="time"
														className="input mt-2"
														value={weeklyTime}
														onChange={(event) =>
															setWeeklyTime(event.target.value)
														}
													/>
												</div>
											</div>
										)}

										{scheduleKind === "cron" && (
											<div>
												<label
													htmlFor="automation-cron"
													className="text-xs uppercase tracking-wide text-text-tertiary"
												>
													Cron Expression
												</label>
												<input
													id="automation-cron"
													className="input mt-2 font-mono"
													value={cronExpression}
													onChange={(event) =>
														setCronExpression(event.target.value)
													}
												/>
											</div>
										)}

										<div className="rounded-xl border border-border-subtle bg-bg-secondary/50 px-4 py-3">
											<div className="text-[10px] uppercase tracking-wide text-text-tertiary">
												Schedule Preview
											</div>
											<div className="mt-2 text-sm text-text-primary">
												{schedulePreview.label}
											</div>
											<div className="mt-1 text-xs text-text-muted">
												Next run:{" "}
												{previewNextRun
													? `${formatDateLabel(
															previewNextRun,
														)} · ${formatRelativeTime(previewNextRun)}`
													: "—"}
											</div>
											{previewLoading && (
												<div className="mt-2 text-xs text-text-tertiary">
													Validating schedule...
												</div>
											)}
											{previewError ? (
												<div className="mt-2 text-xs text-error">
													{previewError}
												</div>
											) : !previewTimezoneValid ? (
												<div className="mt-2 text-xs text-text-muted">
													Timezone is invalid. Using UTC.
												</div>
											) : null}
										</div>

										<div className="rounded-xl border border-border-subtle bg-bg-secondary/50 px-4 py-3">
											<div className="flex items-center justify-between gap-4">
												<div>
													<div className="text-[10px] uppercase tracking-wide text-text-tertiary">
														Run Window
													</div>
													<div className="text-xs text-text-muted mt-1">
														Only run during this local time range.
													</div>
												</div>
												<label className="inline-flex items-center gap-2 text-xs text-text-tertiary">
													<input
														type="checkbox"
														checked={runWindowEnabled}
														onChange={(event) =>
															setRunWindowEnabled(event.target.checked)
														}
														className="h-4 w-4 rounded border-line-subtle bg-bg-tertiary text-accent focus:ring-accent"
													/>
													<span>{runWindowEnabled ? "On" : "Off"}</span>
												</label>
											</div>
											{runWindowEnabled && (
												<div className="mt-3 space-y-3">
													<div className="grid grid-cols-2 gap-3">
														<div>
															<label
																htmlFor="automation-window-start"
																className="text-xs uppercase tracking-wide text-text-tertiary"
															>
																Start
															</label>
															<input
																id="automation-window-start"
																type="time"
																className="input mt-2"
																value={runWindowStart}
																onChange={(event) =>
																	setRunWindowStart(event.target.value)
																}
															/>
														</div>
														<div>
															<label
																htmlFor="automation-window-end"
																className="text-xs uppercase tracking-wide text-text-tertiary"
															>
																End
															</label>
															<input
																id="automation-window-end"
																type="time"
																className="input mt-2"
																value={runWindowEnd}
																onChange={(event) =>
																	setRunWindowEnd(event.target.value)
																}
															/>
														</div>
													</div>
													<div>
														<div className="text-xs uppercase tracking-wide text-text-tertiary">
															Days
														</div>
														<div className="mt-2 flex flex-wrap gap-2 text-[11px] text-text-muted">
															<button
																type="button"
																className="btn-ghost text-[11px]"
																onClick={() =>
																	setRunWindowDays([1, 2, 3, 4, 5])
																}
															>
																Weekdays
															</button>
															<button
																type="button"
																className="btn-ghost text-[11px]"
																onClick={() => setRunWindowDays([0, 6])}
															>
																Weekends
															</button>
															<button
																type="button"
																className="btn-ghost text-[11px]"
																onClick={() =>
																	setRunWindowDays(
																		dayOptions.map((day) => day.value),
																	)
																}
															>
																Every day
															</button>
														</div>
														<div className="mt-2 flex flex-wrap gap-2">
															{dayOptions.map((day) => {
																const selected = runWindowDays.includes(
																	day.value,
																);
																return (
																	<button
																		key={day.value}
																		type="button"
																		className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
																			selected
																				? "border-accent bg-accent/15 text-accent"
																				: "border-border-subtle text-text-muted hover:border-border-default"
																		}`}
																		onClick={() => {
																			setRunWindowDays((prev) =>
																				prev.includes(day.value)
																					? prev.filter(
																							(item) => item !== day.value,
																						)
																					: [...prev, day.value],
																			);
																		}}
																	>
																		{day.label}
																	</button>
																);
															})}
														</div>
													</div>
												</div>
											)}
										</div>
									</div>
								</div>

								<div className={sectionCardClass}>
									<div className="text-xs uppercase tracking-wide text-text-tertiary">
										Run Controls
									</div>
									<div className="mt-3 space-y-3">
										<div className="grid grid-cols-2 gap-3">
											<div>
												<label
													htmlFor="automation-session-mode"
													className="text-xs uppercase tracking-wide text-text-tertiary"
												>
													Session Mode
												</label>
												<select
													id="automation-session-mode"
													className="input mt-2"
													value={sessionMode}
													onChange={(event) =>
														setSessionMode(
															event.target.value as "reuse" | "new",
														)
													}
												>
													<option value="reuse">Continue session</option>
													<option value="new">New session per run</option>
												</select>
											</div>
											<div>
												<label
													htmlFor="automation-session"
													className="text-xs uppercase tracking-wide text-text-tertiary"
												>
													Session
												</label>
												<select
													id="automation-session"
													className="input mt-2"
													disabled={sessionMode !== "reuse"}
													value={sessionId || ""}
													onChange={(event) =>
														setSessionId(event.target.value || null)
													}
												>
													<option value="">Select session</option>
													{sessions.map((session) => (
														<option key={session.id} value={session.id}>
															{session.title || "Untitled"}
														</option>
													))}
												</select>
											</div>
										</div>

										<div className="grid grid-cols-2 gap-3">
											<div>
												<label
													htmlFor="automation-model"
													className="text-xs uppercase tracking-wide text-text-tertiary"
												>
													Model
												</label>
												<select
													id="automation-model"
													className="input mt-2"
													value={model || ""}
													onChange={(event) =>
														setModel(event.target.value || undefined)
													}
												>
													<option value="">Default</option>
													{models.map((modelOption) => (
														<option
															key={`${modelOption.provider}:${modelOption.id}`}
															value={`${modelOption.provider}:${modelOption.id}`}
														>
															{modelOption.name || modelOption.id}
														</option>
													))}
												</select>
											</div>
											<div>
												<label
													htmlFor="automation-thinking"
													className="text-xs uppercase tracking-wide text-text-tertiary"
												>
													Thinking
												</label>
												<select
													id="automation-thinking"
													className="input mt-2"
													value={thinkingLevel}
													onChange={(event) =>
														setThinkingLevel(
															event.target.value as ThinkingLevel,
														)
													}
												>
													{thinkingOptions.map((option) => (
														<option key={option} value={option}>
															{option}
														</option>
													))}
												</select>
											</div>
										</div>

										<div className="grid grid-cols-2 gap-3">
											<div>
												<label
													htmlFor="automation-concurrency"
													className="text-xs uppercase tracking-wide text-text-tertiary"
												>
													Concurrency
												</label>
												<select
													id="automation-concurrency"
													className="input mt-2"
													value={exclusiveRun ? "exclusive" : "parallel"}
													onChange={(event) =>
														setExclusiveRun(event.target.value === "exclusive")
													}
												>
													<option value="parallel">Allow parallel runs</option>
													<option value="exclusive">Run exclusively</option>
												</select>
											</div>
											<div>
												<label
													htmlFor="automation-notify-success"
													className="text-xs uppercase tracking-wide text-text-tertiary"
												>
													Notifications
												</label>
												<div className="mt-2 space-y-2 text-xs text-text-tertiary">
													<label className="inline-flex items-center gap-2">
														<input
															id="automation-notify-success"
															type="checkbox"
															checked={notifyOnSuccess}
															onChange={(event) =>
																setNotifyOnSuccess(event.target.checked)
															}
															className="h-4 w-4 rounded border-line-subtle bg-bg-tertiary text-accent focus:ring-accent"
														/>
														<span>Success</span>
													</label>
													<label className="inline-flex items-center gap-2">
														<input
															type="checkbox"
															checked={notifyOnFailure}
															onChange={(event) =>
																setNotifyOnFailure(event.target.checked)
															}
															className="h-4 w-4 rounded border-line-subtle bg-bg-tertiary text-accent focus:ring-accent"
														/>
														<span>Failure</span>
													</label>
												</div>
												<div className="text-[11px] text-text-muted mt-2">
													Uses background notification settings from Preferences
													({notificationsEnabled ? "On" : "Off"}).
												</div>
											</div>
										</div>
									</div>
								</div>

								<div className={sectionCardClass}>
									<div className="text-xs uppercase tracking-wide text-text-tertiary">
										Context
									</div>
									<div className="mt-3 space-y-3">
										<div>
											<label
												htmlFor="automation-context-input"
												className="text-xs uppercase tracking-wide text-text-tertiary"
											>
												Context Files
											</label>
											<div className="mt-2 flex gap-2">
												<input
													id="automation-context-input"
													className="input"
													placeholder="src/server/routes.ts"
													value={contextInput}
													onChange={(event) =>
														setContextInput(event.target.value)
													}
													onKeyDown={(event) => {
														if (event.key === "Enter") {
															event.preventDefault();
															handleAddContextPath();
														}
													}}
												/>
												<button
													type="button"
													className="btn-secondary"
													onClick={handleAddContextPath}
												>
													Add
												</button>
												<button
													type="button"
													className="btn-secondary"
													onClick={handlePickContextFile}
												>
													Pick
												</button>
											</div>
											{contextPaths.length > 0 && (
												<div className="mt-3 flex flex-wrap gap-2">
													{contextPaths.map((path, index) => (
														<span
															key={path}
															className="badge bg-bg-tertiary text-text-secondary"
														>
															{path}
															<button
																type="button"
																className="ml-2 text-text-muted hover:text-text-primary"
																onClick={() =>
																	setContextPaths((prev) =>
																		prev.filter((_, i) => i !== index),
																	)
																}
															>
																×
															</button>
														</span>
													))}
												</div>
											)}
										</div>

										<div>
											<label
												htmlFor="automation-context-folder-input"
												className="text-xs uppercase tracking-wide text-text-tertiary"
											>
												Context Folders
											</label>
											<div className="mt-2 flex gap-2">
												<input
													id="automation-context-folder-input"
													className="input"
													placeholder="src/server"
													value={contextFolderInput}
													onChange={(event) =>
														setContextFolderInput(event.target.value)
													}
													onKeyDown={(event) => {
														if (event.key === "Enter") {
															event.preventDefault();
															handleAddContextFolder();
														}
													}}
												/>
												<button
													type="button"
													className="btn-secondary"
													onClick={handleAddContextFolder}
												>
													Add
												</button>
												<button
													type="button"
													className="btn-secondary"
													onClick={handlePickContextFolder}
												>
													Pick
												</button>
											</div>
											{contextFolders.length > 0 && (
												<div className="mt-3 flex flex-wrap gap-2">
													{contextFolders.map((path) => (
														<span
															key={path}
															className="badge bg-bg-tertiary text-text-secondary"
														>
															{path}
															<button
																type="button"
																className="ml-2 text-text-muted hover:text-text-primary"
																onClick={() =>
																	setContextFolders((prev) =>
																		prev.filter((item) => item !== path),
																	)
																}
															>
																×
															</button>
														</span>
													))}
												</div>
											)}
											<div className="text-[11px] text-text-muted mt-2">
												Folders snapshot the first few readable files and inject
												them into the prompt.
											</div>
										</div>
									</div>
								</div>

								<div className="flex items-center justify-between pt-2">
									<div className="text-xs text-text-muted">
										Automations run with auto-approval enabled for tools.
									</div>
									<button
										type="button"
										className="btn-primary"
										disabled={isSubmitDisabled}
										onClick={handleSubmit}
									>
										{editingId ? "Update" : "Create"}
									</button>
								</div>
							</div>
						</div>

						<div className="card p-5">
							<h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">
								Automation Details
							</h3>
							{selectedAutomation ? (
								<div className="space-y-4 text-sm text-text-secondary">
									<div>
										<div className="text-xs uppercase tracking-wide text-text-tertiary">
											Status
										</div>
										<div className="mt-1">
											{selectedAutomation.running
												? "Running"
												: selectedAutomation.enabled
													? "Enabled"
													: "Paused"}
										</div>
									</div>
									<div>
										<div className="text-xs uppercase tracking-wide text-text-tertiary">
											Schedule
										</div>
										<div className="mt-1">
											{selectedAutomation.scheduleLabel ||
												selectedAutomation.schedule ||
												"One-time"}
										</div>
									</div>
									{selectedAutomation.runWindow && (
										<div>
											<div className="text-xs uppercase tracking-wide text-text-tertiary">
												Run Window
											</div>
											<div className="mt-1">
												{selectedAutomation.runWindow.start}–
												{selectedAutomation.runWindow.end}
												{selectedAutomation.runWindow.days &&
													selectedAutomation.runWindow.days.length > 0 && (
														<span className="text-text-muted">
															{" "}
															·{" "}
															{[...selectedAutomation.runWindow.days]
																.sort((a, b) => a - b)
																.map(
																	(day) =>
																		dayOptions.find((opt) => opt.value === day)
																			?.label,
																)
																.filter(Boolean)
																.join(", ")}
														</span>
													)}
											</div>
										</div>
									)}
									<div className="grid grid-cols-2 gap-4">
										<div>
											<div className="text-xs uppercase tracking-wide text-text-tertiary">
												Next Run
											</div>
											<div className="mt-1">
												{selectedAutomation.nextRun
													? formatDateLabel(selectedAutomation.nextRun)
													: "—"}
											</div>
										</div>
										<div>
											<div className="text-xs uppercase tracking-wide text-text-tertiary">
												Last Run
											</div>
											<div className="mt-1">
												{selectedAutomation.lastRunAt
													? formatDateLabel(selectedAutomation.lastRunAt)
													: "—"}
											</div>
										</div>
									</div>
									<div className="grid grid-cols-2 gap-4">
										<div>
											<div className="text-xs uppercase tracking-wide text-text-tertiary">
												Concurrency
											</div>
											<div className="mt-1">
												{selectedAutomation.exclusive
													? "Exclusive"
													: "Parallel"}
											</div>
										</div>
										<div>
											<div className="text-xs uppercase tracking-wide text-text-tertiary">
												Notify
											</div>
											<div className="mt-1">
												{[
													selectedAutomation.notifyOnSuccess ? "Success" : null,
													selectedAutomation.notifyOnFailure ? "Failure" : null,
												]
													.filter(Boolean)
													.join(", ") || "Off"}
											</div>
										</div>
									</div>
									<div>
										<div className="text-xs uppercase tracking-wide text-text-tertiary">
											Context
										</div>
										<div className="mt-1 text-xs text-text-muted">
											{selectedAutomation.contextPaths?.length ?? 0} files ·{" "}
											{selectedAutomation.contextFolders?.length ?? 0} folders
										</div>
									</div>
									<div className="grid grid-cols-2 gap-4">
										<div>
											<div className="text-xs uppercase tracking-wide text-text-tertiary">
												Runs
											</div>
											<div className="mt-1">
												{selectedAutomation.runCount ?? 0}
											</div>
										</div>
										<div>
											<div className="text-xs uppercase tracking-wide text-text-tertiary">
												Last Duration
											</div>
											<div className="mt-1">
												{formatDuration(selectedAutomation.lastRunDurationMs)}
											</div>
										</div>
									</div>
									<div>
										<div className="text-xs uppercase tracking-wide text-text-tertiary">
											Last Output
										</div>
										<div className="mt-2 whitespace-pre-wrap text-xs bg-bg-tertiary/40 border border-border-subtle rounded-xl p-3 text-text-muted max-h-40 overflow-y-auto">
											{selectedAutomation.lastOutput ||
												"No output captured yet."}
										</div>
									</div>
									{selectedAutomation.lastRunError && (
										<div>
											<div className="text-xs uppercase tracking-wide text-text-tertiary">
												Last Error
											</div>
											<div className="mt-2 text-xs text-error bg-error/10 border border-error/40 rounded-xl p-3">
												{selectedAutomation.lastRunError}
											</div>
										</div>
									)}
									{selectedAutomation.lastSessionId && (
										<button
											type="button"
											className="btn-secondary w-full"
											onClick={() =>
												onOpenSession(selectedAutomation.lastSessionId!)
											}
										>
											Open latest session
										</button>
									)}
								</div>
							) : (
								<div className="text-sm text-text-muted">
									Select an automation to see details.
								</div>
							)}
						</div>

						<div className="card p-5">
							<div className="flex items-center justify-between mb-4">
								<h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
									Run History
								</h3>
								{selectedAutomation?.runHistory?.length ? (
									<button
										type="button"
										className="text-xs text-text-muted hover:text-text-primary"
										onClick={() => {
											void updateAutomation(selectedAutomation.id, {
												clearHistory: true,
											});
										}}
									>
										Clear history
									</button>
								) : null}
							</div>
							{selectedAutomation ? (
								selectedAutomation.runHistory &&
								selectedAutomation.runHistory.length > 0 ? (
									<div className="space-y-3">
										{selectedAutomation.runHistory.map((run) => {
											const statusClass =
												run.status === "success"
													? "badge-success"
													: run.status === "failure"
														? "badge bg-error/10 text-error"
														: "badge bg-bg-tertiary text-text-muted";
											const triggerLabel =
												run.trigger === "manual"
													? "Manual"
													: run.trigger === "schedule"
														? "Scheduled"
														: "Run";
											return (
												<div
													key={run.id}
													className="rounded-xl border border-border-subtle bg-bg-secondary/40 p-3"
												>
													<div className="flex items-center justify-between gap-3">
														<div className="text-sm text-text-primary">
															{formatDateLabel(run.finishedAt)}
														</div>
														<span className={statusClass}>{run.status}</span>
													</div>
													<div className="mt-1 text-xs text-text-muted">
														{triggerLabel} · {formatDuration(run.durationMs)}
													</div>
													{run.error && (
														<div className="mt-2 text-xs text-error">
															{run.error}
														</div>
													)}
													{run.output && (
														<div className="mt-2 whitespace-pre-wrap text-xs bg-bg-tertiary/40 border border-border-subtle rounded-xl p-3 text-text-muted max-h-32 overflow-y-auto">
															{run.output}
														</div>
													)}
													{run.sessionId && (
														<button
															type="button"
															className="btn-secondary w-full mt-3"
															onClick={() => onOpenSession(run.sessionId!)}
														>
															Open run session
														</button>
													)}
												</div>
											);
										})}
									</div>
								) : (
									<div className="text-sm text-text-muted">
										No runs captured yet.
									</div>
								)
							) : (
								<div className="text-sm text-text-muted">
									Select an automation to see run history.
								</div>
							)}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
