import type { Model } from "./types";

export const getModelKey = (model: Model): string =>
	`${model.provider}:${model.id}`;

export const dedupeModels = (list: Model[]): Model[] => {
	const seen = new Set<string>();
	return list.filter((model) => {
		const key = getModelKey(model);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
};
