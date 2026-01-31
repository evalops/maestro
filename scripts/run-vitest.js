import { spawnSync } from "node:child_process";

if (process.env.FORCE_COLOR && process.env.NO_COLOR) {
	Reflect.deleteProperty(process.env, "NO_COLOR");
}

const args = process.argv.slice(2);
const result = spawnSync("bunx", ["vitest", ...args], {
	stdio: "inherit",
	env: process.env,
	shell: process.platform === "win32",
});

if (result.error) {
	throw result.error;
}

process.exit(result.status ?? 1);
