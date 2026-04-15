import { promises as fs } from "node:fs";
import { join } from "node:path";

async function main() {
	const packageJson = JSON.parse(await fs.readFile("package.json", "utf8"));
	const { version, description = "Composer CLI" } = packageJson;

	const payload = {
		version,
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
