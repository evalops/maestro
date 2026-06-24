import { mergeMaestroSettings } from "@evalops/contracts";
import type { UserSettings } from "../db/schema.js";

/**
 * Merge an incoming user-settings patch onto the previously stored settings.
 *
 * The `maestro` namespace is deep-merged and normalized against the
 * MaestroSettings catalog (`mergeMaestroSettings`), so only typed, valid
 * runtime knobs are ever stored on `users.settings`. Scalar/array fields are
 * replaced.
 *
 * `twoFactor` is managed exclusively by the dedicated 2FA enrollment flow and
 * is never accepted from a generic settings patch — the previous value is
 * always preserved so this endpoint cannot be used to overwrite or strip 2FA
 * state (e.g. backup codes or the TOTP secret).
 */
export function mergeUserSettings(
	previous: UserSettings | null | undefined,
	incoming: UserSettings,
): UserSettings {
	const previousSettings: UserSettings = previous ?? {};

	const result: UserSettings = {
		...previousSettings,
		...incoming,
	};

	const mergedMaestro = mergeMaestroSettings(
		previousSettings.maestro,
		incoming.maestro,
	);
	if (Object.keys(mergedMaestro).length > 0) {
		result.maestro = mergedMaestro;
	} else {
		delete result.maestro;
	}

	// twoFactor is intentionally pinned to the previous value (see docstring).
	if (previousSettings.twoFactor !== undefined) {
		result.twoFactor = previousSettings.twoFactor;
	} else {
		delete result.twoFactor;
	}

	return result;
}
