/**
 * @deprecated TypeScript headless agent runtime removed.
 * Use native `maestro-tui --headless` (launched via the Node shim).
 */

export async function runHeadlessMode(..._args: unknown[]): Promise<never> {
	throw new Error(
		[
			"TypeScript runHeadlessMode has been removed.",
			"Headless/RPC protocol mode runs on native maestro-tui --headless.",
			"The CLI shim routes --headless / --mode headless|rpc automatically.",
		].join(" "),
	);
}
