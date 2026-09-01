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
const stageContents = (stageName) => {
	const match = dockerfile.match(
		new RegExp(
			`(?:^|\\n)FROM\\s+[^\\n]+\\s+AS\\s+${stageName}\\b([\\s\\S]*?)(?=\\nFROM\\s|$)`,
			"i",
		),
	);
	return match?.[1] ?? "";
};
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

const runtimeBoundaryCopy = /COPY\s+packages\/runtime-rs\s+\.\/packages\/runtime-rs/;
const plannerStage = stageContents("planner");
const nativeStage = stageContents("native");

const missing = required
	.filter(([pattern]) => !pattern.test(dockerfile))
	.map(([, label]) => label);
if (!nativeStageHasRustToolchain) {
	missing.unshift("Rust native build stage");
}
if (!runtimeBoundaryCopy.test(plannerStage)) {
	missing.push("native runtime boundary crate in planner Docker stage");
}
if (!runtimeBoundaryCopy.test(nativeStage)) {
	missing.push("native runtime boundary crate in native Docker stage");
}
if (missing.length > 0) {
	console.error(`Dockerfile is missing native runtime contracts: ${missing.join(", ")}`);
	process.exit(1);
}

// A workspace member that no build stage copies is invisible until the image
// build runs, and the image build runs only on the publisher. Bind the copy
// list to the checked-in workspace so the next dependency addition fails on
// its own pull request instead.
const cargoManifestPath = join(process.cwd(), "Cargo.toml");
if (!existsSync(cargoManifestPath)) {
	console.error("Cargo.toml not found; cannot check the Docker copy list against the workspace.");
	process.exit(1);
}
const cargoManifest = readFileSync(cargoManifestPath, "utf8");
const membersBlock = cargoManifest.match(/members\s*=\s*\[([\s\S]*?)\]/);
if (!membersBlock) {
	console.error("Cargo.toml declares no workspace members array.");
	process.exit(1);
}
const workspaceMembers = [...membersBlock[1].matchAll(/"([^"]+)"/g)]
	.map((match) => match[1].replace(/\/+$/, ""))
	.filter((member) => member.startsWith("packages/"));
const copiesMember = (stage, member) =>
	new RegExp(`COPY\\s+${member.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+\\.\\/${member.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`, "m").test(stage);
const uncopied = [];
for (const member of workspaceMembers) {
	if (!copiesMember(plannerStage, member)) {
		uncopied.push(`${member} in the planner stage`);
	}
	if (!copiesMember(nativeStage, member)) {
		uncopied.push(`${member} in the native stage`);
	}
}
if (uncopied.length > 0) {
	console.error(
		`Dockerfile does not copy every Cargo workspace member: ${uncopied.join(", ")}`,
	);
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
