#!/usr/bin/env node

// Suppress punycode deprecation warning from dependencies
// This warning comes from old dependencies still using the deprecated punycode module
const originalEmit = process.emit.bind(process) as (
	event: string | symbol,
	...args: unknown[]
) => boolean;
process.emit = ((event: string | symbol, ...args: unknown[]) => {
	if (event === "warning") {
		const [firstArg] = args;
		if (
			typeof firstArg === "object" &&
			firstArg !== null &&
			"name" in firstArg &&
			"code" in firstArg &&
			(firstArg as { name?: string; code?: string }).name ===
				"DeprecationWarning" &&
			(firstArg as { name?: string; code?: string }).code === "DEP0040"
		) {
			return false; // Suppress punycode deprecation
		}
	}
	return originalEmit(event, ...args);
}) as typeof process.emit;

function isHeadlessInvocation(args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--headless") {
			return true;
		}
		if (arg === "--mode" && args[i + 1] === "headless") {
			return true;
		}
		if (
			arg?.startsWith("--mode=") &&
			arg.slice("--mode=".length) === "headless"
		) {
			return true;
		}
	}
	return false;
}

function emitHeadlessStartupError(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	const stack = error instanceof Error ? error.stack : undefined;
	try {
		process.stdout.write(
			`${JSON.stringify({
				type: "error",
				message: `Headless startup failed: ${message}`,
				fatal: true,
				error_type: "fatal",
			})}\n`,
		);
	} catch {
		// If stdout is unavailable there is no protocol channel left to use.
	}
	process.stderr.write(`${stack ?? message}\n`);
}

const run = async () => {
	try {
		// Prefer the TypeScript entry when running under Bun during development,
		// but fall back to the compiled JS for bundled/compiled binaries.
		const loadMain = async () => {
			if (process.versions?.bun) {
				const tsEntry = "./main." + "ts";
				try {
					return await import(tsEntry);
				} catch {
					// In compiled binaries the .ts source isn't present; use JS output.
					return await import("./main.js");
				}
			}
			return await import("./main.js");
		};

		const { main } = await loadMain();
		await main(process.argv.slice(2));
	} catch (err) {
		if (isHeadlessInvocation(process.argv.slice(2))) {
			emitHeadlessStartupError(err);
		} else {
			console.error(err);
		}
		process.exit(1);
	}
};

// Call without top-level await so Bun's bytecode compilation (which forbids TLA) can bundle this entry.
void run();
