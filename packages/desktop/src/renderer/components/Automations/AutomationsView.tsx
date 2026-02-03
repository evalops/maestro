import { useEffect, useMemo, useState } from "react";
import { useAutomations } from "../../hooks/useAutomations";
import type {
	AutomationCreateInput,
	AutomationUpdateInput,
} from "../../lib/api-client";
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
	const [model, setModel] = useState<string | undefined>(
		currentModel ? `${currentModel.provider}:${currentModel.id}` : undefined,
	);
	const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("off");

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
		if (!selectedId && automations.length > 0) {
			setSelectedId(automations[0]!.id);
		}
	}, [automations, selectedId]);

	const selectedAutomation = useMemo(
		() => automations.find((item) => item.id === selectedId) || null,
		[automations, selectedId],
	);

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
		setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
		setSessionMode("reuse");
		setSessionId(currentSessionId);
		setContextPaths([]);
		setContextInput("");
		setModel(
			currentModel ? `${currentModel.provider}:${currentModel.id}` : undefined,
		);
		setThinkingLevel("off");
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
		setModel(automation.model || undefined);
		setThinkingLevel(automation.thinkingLevel || "off");

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

	const buildSchedule = () => {
		if (scheduleKind === "once") {
			const runAt = onceDateTime ? new Date(onceDateTime).toISOString() : "";
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
			const days = weeklyDays.length > 0 ? weeklyDays : [1];
			const schedule = `${minute} ${hour} * * ${days.sort().join(",")}`;
			const daysLabel = days
				.sort()
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
	};

	const handleSubmit = async () => {
		if (!name.trim() || !prompt.trim()) return;
		const schedule = buildSchedule();
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

	const isSubmitDisabled =
		!name.trim() ||
		!prompt.trim() ||
		(scheduleKind === "once" && !onceDateTime);

	return (
		<div className="flex-1 overflow-hidden">
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
								<span className="badge-accent">{automations.length} total</span>
							</div>
							{loading ? (
								<div className="space-y-3">
									<div className="h-16 rounded-xl shimmer" />
									<div className="h-16 rounded-xl shimmer" />
								</div>
							) : automations.length === 0 ? (
								<div className="text-sm text-text-muted">
									No automations yet. Build one on the right.
								</div>
							) : (
								<div className="space-y-3">
									{automations.map((automation) => {
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
								</div>

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
										<input
											id="automation-timezone"
											className="input mt-2"
											value={timezone}
											onChange={(event) => setTimezone(event.target.value)}
											placeholder="America/Los_Angeles"
										/>
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
											onChange={(event) => setOnceDateTime(event.target.value)}
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
																		? prev.filter((item) => item !== day.value)
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
												onChange={(event) => setWeeklyTime(event.target.value)}
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
												setSessionMode(event.target.value as "reuse" | "new")
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
												setThinkingLevel(event.target.value as ThinkingLevel)
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
											onChange={(event) => setContextInput(event.target.value)}
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
									</div>
									{contextPaths.length > 0 && (
										<div className="mt-3 flex flex-wrap gap-2">
											{contextPaths.map((path) => (
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
									<div>
										<div className="text-xs uppercase tracking-wide text-text-tertiary">
											Last Output
										</div>
										<div className="mt-2 whitespace-pre-wrap text-xs bg-bg-tertiary/40 border border-border-subtle rounded-xl p-3 text-text-muted max-h-40 overflow-y-auto">
											{selectedAutomation.lastOutput ||
												"No output captured yet."}
										</div>
									</div>
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
					</div>
				</div>
			</div>
		</div>
	);
}
