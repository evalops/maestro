type TelemetryDisablementEnv = {
	MAESTRO_INTERNAL_TELEMETRY_DISABLED?: string;
	EVALOPS_INTERNAL_TELEMETRY_DISABLED?: string;
};

export type TelemetryDisablementSettings = {
	internal?: {
		telemetryDisabled?: boolean;
	};
};

function readBooleanFlag(value: string | undefined): boolean {
	switch (value?.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		default:
			return false;
	}
}

export function isInternalTelemetryDisabled(
	env: TelemetryDisablementEnv = process.env,
): boolean {
	return (
		readBooleanFlag(env.MAESTRO_INTERNAL_TELEMETRY_DISABLED) ||
		readBooleanFlag(env.EVALOPS_INTERNAL_TELEMETRY_DISABLED)
	);
}

export function resolveInternalTelemetryDisabledSetting(
	settings: TelemetryDisablementSettings | null | undefined,
): boolean {
	return settings?.internal?.telemetryDisabled === true;
}
