import { afterEach } from "vitest";

const initialCwd = process.cwd();

afterEach(() => {
	try {
		process.chdir(initialCwd);
	} catch {
		// ignore
	}
});
