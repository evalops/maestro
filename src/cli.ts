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

import { main } from "./main.js";

main(process.argv.slice(2)).catch((err) => {
	console.error(err);
	process.exit(1);
});
