import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SessionEntry } from "../../src/session/types.js";
import { tryParseSessionEntry } from "../../src/session/types.js";

const fixturesDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
	"session-wire",
);

export function readSessionWireFixture(name: string): string {
	return readFileSync(join(fixturesDir, name), "utf8").trim();
}

export function parseSessionWireFixture(name: string): SessionEntry[] {
	return readSessionWireFixture(name)
		.split("\n")
		.map((line) => tryParseSessionEntry(line))
		.filter((entry): entry is SessionEntry => Boolean(entry));
}
