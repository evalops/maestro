#!/usr/bin/env node
// @ts-check

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dockerfilePath = join(process.cwd(), "Dockerfile");
if (!existsSync(dockerfilePath)) {
	console.error("Dockerfile not found.");
	process.exit(1);
}

const dockerfile = readFileSync(dockerfilePath, "utf8");
const nativeStageHasRustToolchain =
	/FROM\s+rust:[^\s]+\s+AS\s+native/.test(dockerfile) ||
	(/FROM\s+\S*cargo-chef:[^\s]+\s+AS\s+chef/.test(dockerfile) &&
		/FROM\s+chef\s+AS\s+native/.test(dockerfile));
const required = [
	[/https:\/\/deb\.debian\.org/, "HTTPS Debian package mirror"],
	[/COPY\s+packages\/web\/dist\s+\.\/packages\/web\/dist/, "versioned browser assets"],
	[
		/COPY\s+--from=native\s+\/app\/target\/release\/maestro\s+\/usr\/local\/bin\/maestro/,
		"native Maestro binary copy",
	],
	[/\bMAESTRO_CONTROL_HOST=0\.0\.0\.0\b/, "Rust server bind environment"],
	[/\bPORT=3000\b/, "Rust server port environment"],
	[/ENTRYPOINT\s+\["maestro"\]/, "native Maestro entrypoint"],
	[/CMD\s+\["web"\]/, "Rust web command"],
];

const missing = required
	.filter(([pattern]) => !pattern.test(dockerfile))
	.map(([, label]) => label);
if (!nativeStageHasRustToolchain) {
	missing.unshift("Rust native build stage");
}
if (missing.length > 0) {
	console.error(`Dockerfile is missing native runtime contracts: ${missing.join(", ")}`);
	process.exit(1);
}
if (/Acquire::https::Verify-(?:Peer|Host)=false/.test(dockerfile)) {
	console.error("Dockerfile must not disable HTTPS certificate verification.");
	process.exit(1);
}
if (/ENTRYPOINT\s+\[(?:"node"|"bun")/.test(dockerfile)) {
	console.error("Dockerfile must not use a Node.js or Bun runtime entrypoint.");
	process.exit(1);
}

console.log("Verified native-only Docker runtime contract.");
