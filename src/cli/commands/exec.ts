/**
 * @deprecated TypeScript exec agent runtime removed.
 * Use native `maestro-tui print|exec` / `maestro exec` (shim → native print).
 */

export async function runExecCommand(..._args: unknown[]): Promise<never> {
	throw new Error(
		[
			"TypeScript runExecCommand has been removed.",
			'Use `maestro exec "…"` which hands off to native maestro-tui --print.',
			"Supports --json, --output-last-message, and --output-schema on the native path.",
		].join(" "),
	);
}
