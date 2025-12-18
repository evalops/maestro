export interface SandboxRuntimeProvider {
	/**
	 * Data to inject into the sandbox's global scope.
	 * Keys become window properties (e.g. { foo: 1 } -> window.foo).
	 */
	getData(): Record<string, unknown>;

	/**
	 * Runtime function injected into the sandbox.
	 * This function will be stringified via .toString() and executed in the iframe.
	 *
	 * IMPORTANT: this function must not reference imports/closures.
	 */
	getRuntime(): (sandboxId: string) => void;

	/**
	 * Optional message handler for bidirectional communication.
	 * Called for every message coming from this sandbox.
	 */
	handleMessage?(
		message: unknown,
		respond: (response: unknown) => void,
	): Promise<void>;

	/**
	 * Human-readable description of globals/functions provided.
	 * Reserved for future tool prompting.
	 */
	getDescription(): string;
}
