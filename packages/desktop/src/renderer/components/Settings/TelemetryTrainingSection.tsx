import { useMemo, useState } from "react";
import type { TelemetryStatus, TrainingStatus } from "../../lib/api-client";

export type TelemetryTrainingAction = "on" | "off" | "reset";

export interface TelemetryViewModel {
	statusLabel: string;
	dataLabel: string;
	destinationLabel: string;
	destinationDetail: string;
	destinationExplanation: string;
	sourceLabel: string;
	sourceExplanation: string;
	samplingLabel: string;
	samplingExplanation: string;
	overrideLabel: string;
	overrideExplanation: string;
	reasonExplanation: string;
	exportExplanation: string;
}

export interface TrainingViewModel {
	preferenceLabel: string;
	dataLabel: string;
	sourceLabel: string;
	sourceExplanation: string;
	scopeExplanation: string;
	overrideLabel: string;
	overrideExplanation: string;
	reasonExplanation: string;
}

function ensureSentence(text: string): string {
	return /[.!?]$/.test(text) ? text : `${text}.`;
}

function buildTelemetrySource(status: TelemetryStatus | null) {
	if (!status) {
		return {
			sourceLabel: "Unknown",
			sourceExplanation: "Base telemetry source is unavailable.",
		};
	}

	if (status.flagValue !== undefined) {
		return {
			sourceLabel: "Env flag",
			sourceExplanation: `COMPOSER_TELEMETRY=${status.flagValue} controls the base telemetry setting.`,
		};
	}

	if (status.endpoint) {
		return {
			sourceLabel: "HTTP config",
			sourceExplanation: `Telemetry uses the configured HTTP endpoint at ${status.endpoint}.`,
		};
	}

	if (status.filePath) {
		return {
			sourceLabel: "Local default",
			sourceExplanation: `Telemetry writes to the local log file at ${status.filePath}.`,
		};
	}

	return {
		sourceLabel: "App default",
		sourceExplanation: "Telemetry follows the app default for this device.",
	};
}

function buildTelemetryOverride(status: TelemetryStatus | null) {
	if (!status?.runtimeOverride) {
		return {
			overrideLabel: "None",
			overrideExplanation:
				"No session override is active. Reset uses the base source shown above.",
		};
	}

	return {
		overrideLabel:
			status.runtimeOverride === "enabled" ? "Enabled" : "Disabled",
		overrideExplanation: ensureSentence(
			status.overrideReason
				? `Current session override: ${status.overrideReason}`
				: `Telemetry is forced ${status.runtimeOverride} for this app`,
		),
	};
}

function buildTelemetryReasonExplanation(
	status: TelemetryStatus | null,
): string {
	if (!status) {
		return "Telemetry status is unavailable.";
	}

	if (status.runtimeOverride) {
		return ensureSentence(
			`Session override active: ${status.overrideReason ?? `telemetry forced ${status.runtimeOverride}`}`,
		);
	}

	if (!status.enabled) {
		if (status.reason === "flag disabled") {
			return "Telemetry is disabled by the environment flag.";
		}
		if (status.reason === "sampling=0") {
			return "Telemetry is effectively off because the sample rate is 0%.";
		}
		return ensureSentence(`Telemetry is off (${status.reason})`);
	}

	if (status.reason === "endpoint") {
		return "Telemetry is enabled and sent to the configured HTTP endpoint.";
	}

	if (status.reason === "file") {
		return "Telemetry is enabled and written to a local file.";
	}

	return ensureSentence(`Reason: ${status.reason}`);
}

function buildTrainingSource(status: TrainingStatus | null) {
	if (!status) {
		return {
			sourceLabel: "Unknown",
			sourceExplanation: "Base training preference is unavailable.",
		};
	}

	if (status.flagValue !== undefined) {
		return {
			sourceLabel: "Env flag",
			sourceExplanation: `COMPOSER_TRAINING_OPT_OUT=${status.flagValue} sets the base training preference.`,
		};
	}

	return {
		sourceLabel: "Provider default",
		sourceExplanation:
			"No environment override is set. Providers use their default data-collection policy.",
	};
}

function buildTrainingOverride(status: TrainingStatus | null) {
	if (!status?.runtimeOverride) {
		return {
			overrideLabel: "None",
			overrideExplanation:
				"No session override is active. Reset uses the base source shown above.",
		};
	}

	return {
		overrideLabel: status.runtimeOverride === "opted-in" ? "Opt-in" : "Opt-out",
		overrideExplanation: ensureSentence(
			status.overrideReason
				? `Current session override: ${status.overrideReason}`
				: `Training is forced ${status.runtimeOverride} for this app`,
		),
	};
}

function buildTrainingReasonExplanation(status: TrainingStatus | null): string {
	if (!status) {
		return "Training preference is unavailable.";
	}

	if (status.runtimeOverride) {
		return ensureSentence(
			`Session override active: ${status.overrideReason ?? `training forced ${status.runtimeOverride}`}`,
		);
	}

	if (status.flagValue !== undefined) {
		return `Base preference comes from COMPOSER_TRAINING_OPT_OUT=${status.flagValue}.`;
	}

	if (status.preference === "provider-default") {
		return "Providers use their default training policy.";
	}

	return ensureSentence(`Reason: ${status.reason}`);
}

export interface TelemetryTrainingSectionProps {
	telemetryStatus: TelemetryStatus | null;
	trainingStatus: TrainingStatus | null;
	updateTelemetry: (action: TelemetryTrainingAction) => Promise<void>;
	updateTraining: (action: TelemetryTrainingAction) => Promise<void>;
}

export function buildTelemetryViewModel(
	status: TelemetryStatus | null,
): TelemetryViewModel {
	const enabled = status?.enabled ?? false;
	const sampleRate = status?.sampleRate ?? 0;
	const percent = Math.round(sampleRate * 100);
	const destinationDetail = enabled
		? (status?.endpoint ?? status?.filePath ?? "")
		: "";
	const source = buildTelemetrySource(status);
	const override = buildTelemetryOverride(status);

	return {
		statusLabel: enabled ? "On" : "Off",
		dataLabel: !enabled
			? "No events recorded"
			: sampleRate < 1
				? `Minimal (${percent}% sampled)`
				: "Full",
		destinationLabel: !enabled
			? "Local (disabled)"
			: status?.endpoint
				? "HTTP endpoint"
				: status?.filePath
					? "Local log file"
					: "Unknown",
		destinationDetail,
		destinationExplanation: !enabled
			? "Nowhere. Telemetry is disabled."
			: status?.endpoint
				? `Your endpoint receives JSON event payloads: ${status.endpoint}`
				: status?.filePath
					? `Events are written to a local log file: ${status.filePath}`
					: "Telemetry is enabled, but no destination is configured.",
		...source,
		samplingLabel: !enabled || !status ? "—" : `${percent}%`,
		samplingExplanation: !enabled
			? "Sampling applies only when enabled."
			: sampleRate < 1
				? "Only a portion of events are recorded."
				: "All telemetry events are recorded.",
		...override,
		reasonExplanation: buildTelemetryReasonExplanation(status),
		exportExplanation:
			enabled && status?.filePath
				? `Copy the log file at ${status.filePath}.`
				: enabled && status?.endpoint
					? "Export data from your configured endpoint."
					: "No logs are written when telemetry is disabled.",
	};
}

export function buildTrainingViewModel(
	status: TrainingStatus | null,
): TrainingViewModel {
	if (!status) {
		return {
			preferenceLabel: "Unknown",
			dataLabel: "Unknown",
			sourceLabel: "Unknown",
			sourceExplanation: "Base training preference is unavailable.",
			scopeExplanation: "Applies to requests from this app.",
			overrideLabel: "None",
			overrideExplanation:
				"No session override is active. Reset uses the base source shown above.",
			reasonExplanation: "Training preference is unavailable.",
		};
	}

	const source = buildTrainingSource(status);
	const override = buildTrainingOverride(status);

	return {
		preferenceLabel:
			status.preference === "opted-in"
				? "Opted-in"
				: status.preference === "opted-out"
					? "Opted-out"
					: "Provider default",
		dataLabel:
			status.preference === "opted-out"
				? "No training use (opted-out)"
				: status.preference === "opted-in"
					? "Allowed"
					: "Controlled by provider",
		...source,
		scopeExplanation:
			status.preference === "opted-out"
				? "We send an opt-out header to providers that support it."
				: status.preference === "opted-in"
					? "We allow provider data use where supported."
					: "Provider default (controlled by your model account settings).",
		...override,
		reasonExplanation: buildTrainingReasonExplanation(status),
	};
}

export function TelemetryTrainingSection({
	telemetryStatus,
	trainingStatus,
	updateTelemetry,
	updateTraining,
}: TelemetryTrainingSectionProps) {
	const [showPolicyModal, setShowPolicyModal] = useState(false);
	const telemetry = useMemo(
		() => buildTelemetryViewModel(telemetryStatus),
		[telemetryStatus],
	);
	const training = useMemo(
		() => buildTrainingViewModel(trainingStatus),
		[trainingStatus],
	);

	return (
		<>
			<section className="border border-line-subtle rounded-xl overflow-hidden">
				<div className="px-4 py-2 text-xs font-semibold text-text-tertiary border-b border-line-subtle uppercase tracking-wide">
					Telemetry & Training
				</div>
				<div className="p-4 space-y-6">
					<div className="space-y-3">
						<div className="flex items-start justify-between gap-4">
							<div>
								<div className="text-text-primary font-medium">Telemetry</div>
								<div className="text-xs text-text-muted">
									Writes operational metrics (tool names, durations, error
									rates) to a local log file or configured endpoint.
								</div>
							</div>
							<div className="flex items-center gap-2">
								<button
									type="button"
									className="px-2.5 py-1.5 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60"
									onClick={() => setShowPolicyModal(true)}
								>
									Policy
								</button>
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
						<div className="rounded-lg border border-line-subtle/60 bg-bg-tertiary/30 p-3 space-y-1 text-xs text-text-muted">
							<div className="flex items-center justify-between">
								<span>Status</span>
								<span className="text-text-primary">
									{telemetry.statusLabel}
								</span>
							</div>
							<div className="flex items-center justify-between">
								<span>Data</span>
								<span className="text-text-primary">{telemetry.dataLabel}</span>
							</div>
							<div className="flex items-center justify-between">
								<span>Destination</span>
								<span className="text-text-primary">
									{telemetry.destinationLabel}
								</span>
							</div>
							<div className="flex items-center justify-between gap-3">
								<span>Source</span>
								<span className="text-text-primary text-right">
									{telemetry.sourceLabel}
								</span>
							</div>
							{telemetry.destinationDetail && (
								<div
									className="text-[11px] text-text-tertiary truncate"
									title={telemetry.destinationDetail}
								>
									{telemetry.destinationDetail}
								</div>
							)}
							<div className="flex items-center justify-between">
								<span>Sampling</span>
								<span className="text-text-primary">
									{telemetry.samplingLabel}
								</span>
							</div>
							<div className="flex items-center justify-between gap-3">
								<span>Override</span>
								<span className="text-text-primary text-right">
									{telemetry.overrideLabel}
								</span>
							</div>
							<div className="flex items-center justify-between">
								<span>Scope</span>
								<span className="text-text-primary">This device</span>
							</div>
						</div>
						<div className="text-[11px] text-text-tertiary">
							{telemetry.reasonExplanation}
						</div>
					</div>

					<div className="space-y-3">
						<div className="flex items-start justify-between gap-4">
							<div>
								<div className="text-text-primary font-medium">
									Training data
								</div>
								<div className="text-xs text-text-muted">
									Controls the data-collection header sent to model providers.
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
						<div className="rounded-lg border border-line-subtle/60 bg-bg-tertiary/30 p-3 space-y-1 text-xs text-text-muted">
							<div className="flex items-center justify-between">
								<span>Preference</span>
								<span className="text-text-primary">
									{training.preferenceLabel}
								</span>
							</div>
							<div className="flex items-center justify-between">
								<span>Data use</span>
								<span className="text-text-primary">{training.dataLabel}</span>
							</div>
							<div className="flex items-center justify-between gap-3">
								<span>Source</span>
								<span className="text-text-primary text-right">
									{training.sourceLabel}
								</span>
							</div>
							<div className="flex items-center justify-between gap-3">
								<span>Override</span>
								<span className="text-text-primary text-right">
									{training.overrideLabel}
								</span>
							</div>
							<div className="flex items-center justify-between">
								<span>Destination</span>
								<span className="text-text-primary">Model providers</span>
							</div>
							<div className="flex items-center justify-between">
								<span>Scope</span>
								<span className="text-text-primary">
									Requests from this app
								</span>
							</div>
						</div>
						<div className="text-[11px] text-text-tertiary">
							{training.reasonExplanation}
						</div>
					</div>
				</div>
			</section>

			{showPolicyModal && (
				<div className="fixed inset-0 z-[60] flex items-center justify-center">
					<button
						type="button"
						className="absolute inset-0 bg-black/60"
						onClick={() => setShowPolicyModal(false)}
						title="Close telemetry policy"
					/>
					<div className="relative z-[70] w-[560px] max-w-[92vw] rounded-2xl border border-line-subtle bg-bg-secondary shadow-[0_24px_64px_-20px_rgba(0,0,0,0.7)]">
						<div className="flex items-center justify-between px-5 py-4 border-b border-line-subtle">
							<div>
								<h3 className="text-sm font-semibold text-text-primary">
									Telemetry & Training Policy
								</h3>
								<p className="text-xs text-text-muted">
									Plain-English summary for this device.
								</p>
							</div>
							<button
								type="button"
								className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-tertiary/60 transition-colors"
								onClick={() => setShowPolicyModal(false)}
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
						<div className="p-5 space-y-4 text-xs text-text-muted">
							<div>
								<div className="text-[11px] font-semibold text-text-tertiary uppercase tracking-wide">
									What we collect
								</div>
								<p className="mt-2">
									Operational events like tool names, durations,
									success/failure, background task status, API timings, and
									token/cost metrics. Telemetry does not include chat message
									content. Commands are sanitized where possible.
								</p>
							</div>
							<div>
								<div className="text-[11px] font-semibold text-text-tertiary uppercase tracking-wide">
									Where it goes
								</div>
								<p className="mt-2">{telemetry.destinationExplanation}</p>
							</div>
							<div>
								<div className="text-[11px] font-semibold text-text-tertiary uppercase tracking-wide">
									Base source
								</div>
								<p className="mt-2">{telemetry.sourceExplanation}</p>
							</div>
							<div>
								<div className="text-[11px] font-semibold text-text-tertiary uppercase tracking-wide">
									Session override
								</div>
								<p className="mt-2">{telemetry.overrideExplanation}</p>
							</div>
							<div>
								<div className="text-[11px] font-semibold text-text-tertiary uppercase tracking-wide">
									How to disable
								</div>
								<p className="mt-2">
									Use the Telemetry toggle in Settings or run{" "}
									<span className="text-text-primary">/telemetry off</span>.
								</p>
							</div>
							<div>
								<div className="text-[11px] font-semibold text-text-tertiary uppercase tracking-wide">
									How to export logs
								</div>
								<p className="mt-2">{telemetry.exportExplanation}</p>
							</div>
							<div>
								<div className="text-[11px] font-semibold text-text-tertiary uppercase tracking-wide">
									Training data
								</div>
								<p className="mt-2">{training.scopeExplanation}</p>
							</div>
							<div>
								<div className="text-[11px] font-semibold text-text-tertiary uppercase tracking-wide">
									Training source
								</div>
								<p className="mt-2">{training.sourceExplanation}</p>
							</div>
							<div>
								<div className="text-[11px] font-semibold text-text-tertiary uppercase tracking-wide">
									Training override
								</div>
								<p className="mt-2">{training.overrideExplanation}</p>
							</div>
							<div>
								<div className="text-[11px] font-semibold text-text-tertiary uppercase tracking-wide">
									Sampling
								</div>
								<p className="mt-2">{telemetry.samplingExplanation}</p>
							</div>
						</div>
					</div>
				</div>
			)}
		</>
	);
}
