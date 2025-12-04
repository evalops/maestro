import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ZEN_STATE_PATH =
	process.env.COMPOSER_ZEN_STATE ??
	join(homedir(), ".composer", "agent", "zen-state.json");

const KEY_REGEX = /^[A-Za-z0-9._-]+$/;

export function loadZenState(): Record<string, boolean> {
	if (!existsSync(ZEN_STATE_PATH)) return {};
	try {
		const raw = JSON.parse(readFileSync(ZEN_STATE_PATH, "utf-8")) as unknown;
		if (!raw || typeof raw !== "object") return {};
		const entries: [string, boolean][] = [];
		for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
			if (!KEY_REGEX.test(k)) continue;
			if (typeof v === "boolean") entries.push([k, v]);
		}
		return Object.fromEntries(entries);
	} catch {
		return {};
	}
}

export function saveZenState(state: Record<string, boolean>): void {
	const cleaned: Record<string, boolean> = {};
	for (const [k, v] of Object.entries(state)) {
		if (KEY_REGEX.test(k) && typeof v === "boolean") cleaned[k] = v;
	}
	mkdirSync(dirname(ZEN_STATE_PATH), { recursive: true });
	writeFileSync(ZEN_STATE_PATH, JSON.stringify(cleaned, null, 2), "utf-8");
}
