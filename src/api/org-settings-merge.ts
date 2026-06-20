import { mergeMaestroSettings } from "@evalops/contracts";
import type { OrganizationSettings } from "../db/schema.js";

/**
 * Merge an incoming organization-settings patch onto the previously stored
 * settings. Nested namespaces (`internal`, `maestro`) deep-merge with the
 * incoming layer winning at each leaf; scalar/array fields are replaced.
 *
 * The `maestro` namespace is normalized against the MaestroSettings catalog
 * (`mergeMaestroSettings`), so only typed, valid values are ever stored on the
 * jsonb column — the catalog is enforced at the write boundary.
 */
export function mergeOrganizationSettings(
	previous: OrganizationSettings | null | undefined,
	incoming: OrganizationSettings,
): OrganizationSettings {
	const previousSettings: OrganizationSettings = previous ?? {};

	const internal =
		incoming.internal || previousSettings.internal
			? { ...previousSettings.internal, ...incoming.internal }
			: undefined;

	const mergedMaestro = mergeMaestroSettings(
		previousSettings.maestro,
		incoming.maestro,
	);
	const maestro =
		Object.keys(mergedMaestro).length > 0 ? mergedMaestro : undefined;

	const result: OrganizationSettings = {
		...previousSettings,
		...incoming,
	};
	// Nested namespaces are deep-merged above; replace whatever the shallow
	// spread produced so they are never clobbered by an explicit undefined.
	if (internal !== undefined) {
		result.internal = internal;
	} else {
		delete result.internal;
	}
	if (maestro !== undefined) {
		result.maestro = maestro;
	} else {
		delete result.maestro;
	}
	return result;
}
