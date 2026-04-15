import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAgentDir } from "../../config/constants.js";
import { isPlainObject, tryParseJson } from "../../utils/json.js";
import { resolveEnvPath } from "../../utils/path-expansion.js";

const ZEN_STATE_PATH =
	resolveEnvPath(process.env.MAESTRO_ZEN_STATE) ??
	resolve(getAgentDir(), "zen-state.json");

const KEY_REGEX = /^[A-Za-z0-9._-]+$/;

export function loadZenState(): Record<string, boolean> {
	if (!existsSync(ZEN_STATE_PATH)) return {};
	const raw = tryParseJson(readFileSync(ZEN_STATE_PATH, "utf-8"));
	if (!isPlainObject(raw)) return {};
	const entries: [string, boolean][] = [];
	for (const [k, v] of Object.entries(raw)) {
		if (!KEY_REGEX.test(k)) continue;
		if (typeof v === "boolean") entries.push([k, v]);
	}
	return Object.fromEntries(entries);
}

export function saveZenState(state: Record<string, boolean>): void {
	const cleaned: Record<string, boolean> = {};
	for (const [k, v] of Object.entries(state)) {
		if (KEY_REGEX.test(k) && typeof v === "boolean") cleaned[k] = v;
	}
	mkdirSync(dirname(ZEN_STATE_PATH), { recursive: true });
	writeFileSync(ZEN_STATE_PATH, JSON.stringify(cleaned, null, 2), "utf-8");
}
