import { redactPii as coreRedactPii } from "../../security/pii-detector.js";

export const redactPii = coreRedactPii;

export function redactText(input: string): string {
	return coreRedactPii(input);
}

export function redactSnippet(value: unknown, max = 160): string {
	if (typeof value !== "string") return "";
	return redactText(value).slice(0, max);
}

export function redactObject<T extends Record<string, unknown>>(obj: T): T {
	// Shallow redaction for now; can be deepened if needed
	const copy: Record<string, unknown> = { ...obj };
	for (const [k, v] of Object.entries(copy)) {
		if (typeof v === "string") copy[k] = redactText(v);
	}
	return copy as T;
}
