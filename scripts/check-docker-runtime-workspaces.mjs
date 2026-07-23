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
const required = [
	[/FROM\s+rust:[^\s]+\s+AS\s+native/, "Rust native build stage"],
	[/https:\/\/deb\.debian\.org/, "HTTPS Debian package mirror"],
	[/Acquire::https::Verify-Peer=false/, "HTTPS apt fallback without peer verify"],
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
if (missing.length > 0) {
	console.error(`Dockerfile is missing native runtime contracts: ${missing.join(", ")}`);
	process.exit(1);
}
if (/ENTRYPOINT\s+\[(?:"node"|"bun")/.test(dockerfile)) {
	console.error("Dockerfile must not use a Node.js or Bun runtime entrypoint.");
	process.exit(1);
}

console.log("Verified native-only Docker runtime contract.");
