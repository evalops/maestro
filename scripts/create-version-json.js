import { promises as fs } from "node:fs";
import { join } from "node:path";

async function main() {
	const packageJson = JSON.parse(await fs.readFile("package.json", "utf8"));
	const { version, description = "Maestro CLI" } = packageJson;
	const changelog = await fs.readFile("CHANGELOG.md", "utf8");
	const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const heading = new RegExp(`^## \\[?${escaped}\\]?(?:\\s+-.*)?$`, "m");
	const match = heading.exec(changelog);
	const start = match ? match.index + match[0].length : -1;
	const nextHeading = start >= 0 ? /^## /m.exec(changelog.slice(start)) : null;
	const releaseNotes = start >= 0
		? changelog.slice(start, nextHeading ? start + nextHeading.index : changelog.length).trim() || null
		: null;

	const payload = {
		schemaVersion: "evalops.maestro.update-metadata.v1",
		version,
		releaseTag: `v${version}`,
		releaseNotes,
		notes: `${description} v${version} is now available.`,
	};

	await fs.mkdir("dist", { recursive: true });
	const outputPath = join("dist", "version.json");
	await fs.writeFile(outputPath, JSON.stringify(payload, null, 2));
	console.log(`Wrote version metadata to ${outputPath}`);
}

main().catch((error) => {
	console.error("Failed to create version.json", error);
	process.exit(1);
});
