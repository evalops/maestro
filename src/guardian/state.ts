import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { GuardianRunResult, GuardianState } from "./types.js";

const STATE_ROOT = join(homedir(), ".composer", "agent");
const STATE_PATH = process.env.COMPOSER_GUARDIAN_STATE
	? resolve(process.env.COMPOSER_GUARDIAN_STATE)
	: join(STATE_ROOT, "guardian-state.json");

const DEFAULT_STATE: GuardianState = {
	enabled: true,
};

export function getGuardianStatePath(): string {
	return STATE_PATH;
}

export function loadGuardianState(): GuardianState {
	try {
		if (!existsSync(STATE_PATH)) {
			return { ...DEFAULT_STATE };
		}
		const raw = readFileSync(STATE_PATH, "utf-8");
		const parsed = JSON.parse(raw) as Partial<GuardianState>;
		return {
			...DEFAULT_STATE,
			...parsed,
		};
	} catch {
		return { ...DEFAULT_STATE };
	}
}

function persistState(state: GuardianState): GuardianState {
	try {
		mkdirSync(dirname(STATE_PATH), { recursive: true, mode: 0o700 });
		writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), {
			encoding: "utf-8",
			mode: 0o600,
		});
	} catch {
		// Ignore persistence failures; Guardian still runs in-memory.
	}
	return state;
}

export function setGuardianEnabled(enabled: boolean): GuardianState {
	const current = loadGuardianState();
	const next: GuardianState = { ...current, enabled };
	return persistState(next);
}

export function recordGuardianRun(run: GuardianRunResult): GuardianState {
	const current = loadGuardianState();
	const next: GuardianState = { ...current, lastRun: run };
	return persistState(next);
}
