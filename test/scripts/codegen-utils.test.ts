import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	formatRustWithRustfmt,
	rustGeneratedMatches,
} from "../../scripts/codegen-utils.mjs";

const originalRustfmt = process.env.MAESTRO_RUSTFMT;

afterEach(() => {
	if (originalRustfmt === undefined) {
		delete process.env.MAESTRO_RUSTFMT;
		return;
	}
	process.env.MAESTRO_RUSTFMT = originalRustfmt;
});

describe("formatRustWithRustfmt", () => {
	it("supports explicit rustfmt opt-out for write-mode codegen", () => {
		const root = mkdtempSync(join(tmpdir(), "maestro-codegen-utils-"));
		try {
			process.env.MAESTRO_RUSTFMT = "off";
			const source = 'pub const VALUES:&[&str]=&["a",];\n';
			const formatted = 'pub const VALUES: &[&str] = &["a"];\n';

			const output = formatRustWithRustfmt(source, join(root, "out.rs"), {
				rootDir: root,
				label: "generated Rust test file",
			});

			expect(output).toEqual({
				content: source,
				rustfmtAvailable: false,
			});
			expect(
				rustGeneratedMatches(formatted, output.content, {
					rustfmtAvailable: output.rustfmtAvailable,
				}),
			).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
