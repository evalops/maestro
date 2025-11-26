export type TrainingPreference = boolean | null;

const trainingFlag = process.env.COMPOSER_TRAINING_OPT_OUT;

export const parseTrainingFlag = (
	value: string | undefined,
): TrainingPreference => {
	if (!value) return null;
	const normalized = value.trim().toLowerCase();
	if (
		normalized === "1" ||
		normalized === "true" ||
		normalized === "yes" ||
		normalized === "on"
	) {
		return true;
	}
	if (
		normalized === "0" ||
		normalized === "false" ||
		normalized === "no" ||
		normalized === "off"
	) {
		return false;
	}
	return null;
};

const initialTrainingPreference = parseTrainingFlag(trainingFlag);
let trainingPreference: TrainingPreference = initialTrainingPreference;
let trainingOverride: TrainingPreference = null;
let trainingOverrideReason: string | undefined;

export interface TrainingStatus {
	preference: "opted-in" | "opted-out" | "provider-default";
	optOut: TrainingPreference;
	reason: string;
	flagValue?: string;
	runtimeOverride?: "opted-in" | "opted-out";
	overrideReason?: string;
}

export function setTrainingRuntimeOverride(
	optOut: TrainingPreference,
	reason?: string,
): void {
	if (optOut === null) {
		trainingOverride = null;
		trainingOverrideReason = undefined;
		trainingPreference = initialTrainingPreference;
		return;
	}
	trainingOverride = optOut;
	trainingOverrideReason = reason;
	trainingPreference = optOut;
}

export function resetTrainingRuntimeOverride(): void {
	setTrainingRuntimeOverride(null, undefined);
}

export function optIntoTraining(reason?: string): void {
	setTrainingRuntimeOverride(false, reason);
}

export function optOutOfTraining(reason?: string): void {
	setTrainingRuntimeOverride(true, reason);
}

export function getTrainingStatus(): TrainingStatus {
	const effectivePreference = trainingPreference;
	const preference: TrainingStatus["preference"] =
		effectivePreference === true
			? "opted-out"
			: effectivePreference === false
				? "opted-in"
				: "provider-default";
	const runtimeOverride =
		trainingOverride === null
			? undefined
			: trainingOverride
				? ("opted-out" as const)
				: ("opted-in" as const);
	let reason = "provider default";
	if (trainingOverride !== null) {
		reason = trainingOverrideReason ?? "runtime override";
	} else if (trainingFlag) {
		reason = `COMPOSER_TRAINING_OPT_OUT=${trainingFlag}`;
	}

	return {
		preference,
		optOut: effectivePreference,
		reason,
		flagValue: trainingFlag,
		runtimeOverride,
		overrideReason: trainingOverrideReason,
	};
}

export function getTrainingHeaders(): Record<string, string> | undefined {
	if (trainingPreference === null) return undefined;
	return { "X-Data-Collection-Opt-Out": trainingPreference ? "true" : "false" };
}
