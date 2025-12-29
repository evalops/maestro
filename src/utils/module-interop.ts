export type DefaultExport<T> = { default?: T };

export function resolveDefaultExport<T>(
	moduleValue: T | DefaultExport<T> | undefined,
	fallback?: T,
): T {
	if (moduleValue) {
		if (
			(typeof moduleValue === "object" || typeof moduleValue === "function") &&
			"default" in moduleValue
		) {
			const withDefault = moduleValue as DefaultExport<T>;
			if (withDefault.default) {
				return withDefault.default;
			}
		}
		return moduleValue as T;
	}
	if (fallback !== undefined) {
		return fallback;
	}
	throw new Error("Module default export not available");
}
