import { describe, expect, it } from "vitest";
import {
	buildTelemetryViewModel,
	buildTrainingViewModel,
} from "../../packages/desktop/src/renderer/components/Settings/TelemetryTrainingSection";

describe("buildTelemetryViewModel", () => {
	it("describes sampled local telemetry", () => {
		const viewModel = buildTelemetryViewModel({
			enabled: true,
			reason: "configured by policy",
			filePath: "/tmp/composer-telemetry.log",
			sampleRate: 0.25,
		});

		expect(viewModel.statusLabel).toBe("On");
		expect(viewModel.dataLabel).toBe("Minimal (25% sampled)");
		expect(viewModel.destinationLabel).toBe("Local log file");
		expect(viewModel.destinationDetail).toBe("/tmp/composer-telemetry.log");
		expect(viewModel.sourceLabel).toBe("Local default");
		expect(viewModel.samplingLabel).toBe("25%");
		expect(viewModel.samplingExplanation).toBe(
			"Only a portion of events are recorded.",
		);
		expect(viewModel.overrideLabel).toBe("None");
		expect(viewModel.reasonExplanation).toBe("Reason: configured by policy.");
		expect(viewModel.exportExplanation).toBe(
			"Copy the log file at /tmp/composer-telemetry.log.",
		);
	});

	it("describes disabled telemetry", () => {
		const viewModel = buildTelemetryViewModel({
			enabled: false,
			reason: "disabled by user",
			sampleRate: 1,
		});

		expect(viewModel.statusLabel).toBe("Off");
		expect(viewModel.dataLabel).toBe("No events recorded");
		expect(viewModel.destinationLabel).toBe("Local (disabled)");
		expect(viewModel.destinationDetail).toBe("");
		expect(viewModel.sourceLabel).toBe("App default");
		expect(viewModel.samplingLabel).toBe("—");
		expect(viewModel.reasonExplanation).toBe(
			"Telemetry is off (disabled by user).",
		);
	});

	it("describes telemetry session overrides", () => {
		const viewModel = buildTelemetryViewModel({
			enabled: true,
			reason: "flag disabled",
			sampleRate: 1,
			flagValue: "0",
			runtimeOverride: "enabled",
			overrideReason: "enabled via /api/telemetry",
		});

		expect(viewModel.sourceLabel).toBe("Env flag");
		expect(viewModel.sourceExplanation).toBe(
			"COMPOSER_TELEMETRY=0 controls the base telemetry setting.",
		);
		expect(viewModel.overrideLabel).toBe("Enabled");
		expect(viewModel.overrideExplanation).toBe(
			"Current session override: enabled via /api/telemetry.",
		);
		expect(viewModel.reasonExplanation).toBe(
			"Session override active: enabled via /api/telemetry.",
		);
	});
});

describe("buildTrainingViewModel", () => {
	it("describes opted-out training overrides", () => {
		const viewModel = buildTrainingViewModel({
			preference: "opted-out",
			optOut: true,
			reason: "user preference",
			runtimeOverride: "opted-out",
			overrideReason: "user preference",
		});

		expect(viewModel.preferenceLabel).toBe("Opted-out");
		expect(viewModel.dataLabel).toBe("No training use (opted-out)");
		expect(viewModel.sourceLabel).toBe("Provider default");
		expect(viewModel.scopeExplanation).toBe(
			"We send an opt-out header to providers that support it.",
		);
		expect(viewModel.overrideLabel).toBe("Opt-out");
		expect(viewModel.overrideExplanation).toBe(
			"Current session override: user preference.",
		);
		expect(viewModel.reasonExplanation).toBe(
			"Session override active: user preference.",
		);
	});

	it("describes provider defaults", () => {
		const viewModel = buildTrainingViewModel({
			preference: "provider-default",
			optOut: null,
			reason: "provider controls it",
		});

		expect(viewModel.preferenceLabel).toBe("Provider default");
		expect(viewModel.dataLabel).toBe("Controlled by provider");
		expect(viewModel.sourceLabel).toBe("Provider default");
		expect(viewModel.overrideLabel).toBe("None");
		expect(viewModel.scopeExplanation).toBe(
			"Provider default (controlled by your model account settings).",
		);
		expect(viewModel.reasonExplanation).toBe(
			"Providers use their default training policy.",
		);
	});

	it("describes training env flags", () => {
		const viewModel = buildTrainingViewModel({
			preference: "opted-out",
			optOut: true,
			reason: "COMPOSER_TRAINING_OPT_OUT=true",
			flagValue: "true",
		});

		expect(viewModel.sourceLabel).toBe("Env flag");
		expect(viewModel.sourceExplanation).toBe(
			"COMPOSER_TRAINING_OPT_OUT=true sets the base training preference.",
		);
		expect(viewModel.overrideLabel).toBe("None");
		expect(viewModel.reasonExplanation).toBe(
			"Base preference comes from COMPOSER_TRAINING_OPT_OUT=true.",
		);
	});
});
