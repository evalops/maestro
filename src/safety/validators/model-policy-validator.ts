import { matchesModelPattern } from "../../utils/path-matcher.js";
import type { EnterprisePolicy } from "../policy.js";

export function checkModelAccess(
	modelId: string,
	modelPolicy: NonNullable<EnterprisePolicy["models"]>,
): { allowed: boolean; reason?: string } {
	const { allowed, blocked } = modelPolicy;

	if (blocked?.length && matchesModelPattern(modelId, blocked)) {
		return {
			allowed: false,
			reason: `Model "${modelId}" is blocked by enterprise policy.`,
		};
	}

	if (allowed) {
		if (allowed.length === 0 || !matchesModelPattern(modelId, allowed)) {
			return {
				allowed: false,
				reason: `Model "${modelId}" is not in the approved models list.`,
			};
		}
	}

	return { allowed: true };
}
