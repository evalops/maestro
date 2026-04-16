import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(packageRoot, "index.html");
const distRoot = join(packageRoot, "dist");
const distPath = join(distRoot, "index.html");

const source = readFileSync(sourcePath, "utf8");
const hosted = source.replace(
	'<script type="module" src="/src/index.ts"></script>',
	'<script type="module" src="/composer-web.es.js"></script>',
);

if (source === hosted) {
	throw new Error("Failed to rewrite web shell entrypoint for hosted build");
}

mkdirSync(distRoot, { recursive: true });
writeFileSync(distPath, hosted);
