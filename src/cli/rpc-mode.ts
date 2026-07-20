/**
 * @deprecated TypeScript RPC agent runtime removed.
 * Use native `maestro-tui --headless` (RPC is an alias).
 */

export async function runRpcMode(..._args: unknown[]): Promise<never> {
	throw new Error(
		[
			"TypeScript runRpcMode has been removed.",
			"RPC mode runs on native maestro-tui --headless / --rpc.",
			"The CLI shim routes --mode rpc automatically.",
		].join(" "),
	);
}
