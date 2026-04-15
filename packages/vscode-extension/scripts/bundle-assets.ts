import { copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as esbuild from "esbuild";

const rootDir = resolve(__dirname, "..");
const mediaDir = join(rootDir, "media");
const nodeModules = resolve(rootDir, "../../node_modules");

async function build() {
	console.log("Bundling vendor assets...");

	// Bundle JS dependencies
	await esbuild.build({
		entryPoints: ["./scripts/vendor-entry.js"],
		bundle: true,
		outfile: join(mediaDir, "vendor.js"),
		format: "iife",
		globalName: "vendor",
		minify: true,
		platform: "browser",
	});

	// Copy CSS
	try {
		await copyFile(
			join(nodeModules, "highlight.js/styles/github-dark.css"),
			join(mediaDir, "highlight.css"),
		);
		console.log("Copied highlight.css");
	} catch (e) {
		console.error("Failed to copy CSS:", e);
	}
}

build().catch(console.error);
