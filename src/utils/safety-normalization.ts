const DEFAULT_IGNORABLE_CODE_POINTS = /\p{Default_Ignorable_Code_Point}/gu;

export function normalizeSafetyText(value: string): string {
	return value.normalize("NFKC").replace(DEFAULT_IGNORABLE_CODE_POINTS, "");
}

export function normalizeToolNameForSafety(value: string): string {
	return normalizeSafetyText(value).toLowerCase().replace(/-/g, "_").trim();
}
