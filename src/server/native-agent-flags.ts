/**
 * Server agent runtime flags — native (`maestro-tui`) is the only product path.
 *
 * Convention:
 * - Production always uses native headless / one-shot paths.
 * - There is **no** in-process TypeScript Agent escape hatch and **no** soft
 *   fallback from a failed native start to TypeScript.
 * - Automatic native memory work may still be disabled independently.
 */

function envFalsy(value: string | undefined): boolean {
	const v = value?.trim().toLowerCase();
	return v === "0" || v === "false" || v === "no" || v === "off";
}

/**
 * Automatic durable memory extraction/consolidation via native one-shots
 * (`runNativeBackgroundPrompt`) on native server paths (default ON).
 *
 * Off when `MAESTRO_NATIVE_MEMORY` is falsy. Failures must log and continue —
 * never soft-fall back to in-process TypeScript agents.
 */
export function isNativeMemoryEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const raw = env.MAESTRO_NATIVE_MEMORY;
	if (raw === undefined || raw.trim() === "") {
		return true;
	}
	if (envFalsy(raw)) {
		return false;
	}
	return true;
}
