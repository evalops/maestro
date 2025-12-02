import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	loadCommandCatalog,
	parseCommandArgs,
	renderCommandPrompt,
	validateCommandArgs,
} from "../../src/commands/catalog.js";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "composer-cmd-"));
}

describe("command catalog", () => {
	it("loads home and workspace commands with workspace override", () => {
		const home = tempDir();
		const work = tempDir();
		const prevHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const homeDir = join(home, ".composer", "commands");
			mkdirSync(homeDir, { recursive: true });
			writeFileSync(
				join(homeDir, "cmd.json"),
				JSON.stringify({
					name: "hello",
					prompt: "Hi {{name}}",
					description: "home",
				}),
			);
			const wsDir = join(work, ".composer", "commands");
			mkdirSync(wsDir, { recursive: true });
			writeFileSync(
				join(wsDir, "cmd.json"),
				JSON.stringify({
					name: "hello",
					prompt: "Yo {{name}}",
					description: "ws",
				}),
			);
			const catalog = loadCommandCatalog(work);
			expect(catalog).toHaveLength(1);
			expect(catalog[0].prompt).toContain("Yo");
		} finally {
			if (prevHome === undefined) {
				// biome-ignore lint/performance/noDelete: need to unset env var
				delete process.env.HOME;
			} else {
				process.env.HOME = prevHome;
			}
		}
	});

	it("renders prompt with args and validates required args", () => {
		const cmd = {
			name: "greet",
			description: "",
			prompt: "Hi {{name}}",
			args: [{ name: "name", required: true }],
			source: "",
		};
		const validation = validateCommandArgs(cmd, { name: "Ava" });
		expect(validation).toBeNull();
		const rendered = renderCommandPrompt(cmd, { name: "Ava" });
		expect(rendered).toBe("Hi Ava");
	});

	it("parses args with embedded equals and escapes template keys", () => {
		const args = parseCommandArgs([
			"url=https://example.com?foo=bar=baz",
			"user.name=first.last",
		]);
		expect(args.url).toBe("https://example.com?foo=bar=baz");
		const cmd = {
			name: "test",
			prompt: "User: {{user.name}} at {{url}}",
			source: "",
			args: [],
		};
		const rendered = renderCommandPrompt(cmd, args);
		expect(rendered).toBe(
			"User: first.last at https://example.com?foo=bar=baz",
		);
	});
});
