import { readFileSync } from "node:fs";

const config = JSON.parse(
	readFileSync(new URL("../docs/system-paths.json", import.meta.url), "utf8"),
);

const errors = [];

if (!config || typeof config !== "object") {
	errors.push("system-paths.json must export an object");
}

const windowsPaths = Array.isArray(config?.windows) ? config.windows : [];
if (windowsPaths.length === 0) {
	errors.push("system-paths.json must include non-empty windows paths");
}

for (const path of windowsPaths) {
	if (typeof path !== "string") {
		errors.push(`windows path is not a string: ${String(path)}`);
		continue;
	}
	if (!/^[A-Za-z]:\\/.test(path)) {
		errors.push(`windows path must start with drive prefix: ${path}`);
	}
	if (/\\\\/.test(path)) {
		errors.push(`windows path contains double backslashes: ${path}`);
	}
	if (path.includes("/")) {
		errors.push(`windows path contains forward slashes: ${path}`);
	}
}

if (errors.length > 0) {
	console.error("Invalid docs/system-paths.json:");
	for (const error of errors) {
		console.error(`- ${error}`);
	}
	process.exit(1);
}
