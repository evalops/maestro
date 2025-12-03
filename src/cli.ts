#!/usr/bin/env node

// Suppress punycode deprecation warning from dependencies
// This warning comes from old dependencies still using the deprecated punycode module
const originalEmit = process.emit;
// @ts-expect-error - Monkey-patch emit to filter warnings
process.emit = (event, ...args) => {
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
	// @ts-expect-error - Call original with event and args
	return originalEmit.apply(process, [event, ...args]);
};

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
		console.error(err);
		process.exit(1);
	}
};

// Call without top-level await so Bun's bytecode compilation (which forbids TLA) can bundle this entry.
void run();
