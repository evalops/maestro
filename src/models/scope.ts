import type { RegisteredModel } from "./registry.js";
import { getRegisteredModels } from "./registry.js";

const DATE_SUFFIX = /-\d{8}$/;

const isAliasId = (id: string): boolean => {
	if (!id) return false;
	return id.endsWith("-latest") || !DATE_SUFFIX.test(id);
};

const selectPreferredMatch = (
	matches: RegisteredModel[],
): RegisteredModel | null => {
	if (matches.length === 0) {
		return null;
	}
	const aliases = matches.filter((model) => isAliasId(model.id));
	if (aliases.length > 0) {
		return [...aliases].sort((a, b) => b.id.localeCompare(a.id))[0] ?? null;
	}
	return [...matches].sort((a, b) => b.id.localeCompare(a.id))[0] ?? null;
};

export function scopeModels(
	patterns: string[],
	available: RegisteredModel[],
): RegisteredModel[] {
	const scoped: RegisteredModel[] = [];
	for (const rawPattern of patterns) {
		const pattern = rawPattern.trim().toLowerCase();
		if (!pattern) continue;
		const matches = available.filter((model) => {
			const idMatches = model.id.toLowerCase().includes(pattern);
			const nameMatches = model.name?.toLowerCase().includes(pattern);
			return idMatches || Boolean(nameMatches);
		});
		const preferred = selectPreferredMatch(matches);
		if (!preferred) {
			continue;
		}
		const alreadyAdded = scoped.some(
			(entry) =>
				entry.provider === preferred.provider && entry.id === preferred.id,
		);
		if (!alreadyAdded) {
			scoped.push(preferred);
		}
	}
	return scoped;
}

export function resolveModelScope(patterns: string[]): RegisteredModel[] {
	return scopeModels(patterns, getRegisteredModels());
}
