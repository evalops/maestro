import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatRustWithRustfmt } from "../../scripts/codegen-utils.mjs";

const envName = "TEST_RUSTFMT";
const tempDirs: string[] = [];

afterEach(() => {
	delete process.env[envName];
	delete process.env.MAESTRO_RUSTFMT;
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop()!, { force: true, recursive: true });
	}
});

function makeTempDir() {
	const dir = mkdtempSync(join(tmpdir(), "maestro-codegen-utils-"));
	tempDirs.push(dir);
	return dir;
}

describe("formatRustWithRustfmt", () => {
	it.each(["0", "false", "off", "none", "skip", "disabled"])(
		"allows rustfmt to be explicitly disabled with %s in write mode",
		(value) => {
			const rootDir = makeTempDir();
			process.env[envName] = value;
			const source = 'pub fn generated(){println!("ok");}\n';

			const result = formatRustWithRustfmt(
				source,
				join(rootDir, "generated.rs"),
				{
					envNames: [envName],
					label: "generated Rust test file",
					rootDir,
				},
			);

			expect(result).toEqual({ content: source, rustfmtAvailable: false });
		},
	);

	it("allows MAESTRO_RUSTFMT to disable generated Rust formatting", () => {
		const rootDir = makeTempDir();
		process.env.MAESTRO_RUSTFMT = "off";
		const source = 'pub fn generated(){println!("ok");}\n';

		const result = formatRustWithRustfmt(
			source,
			join(rootDir, "generated.rs"),
			{
				label: "generated Rust test file",
				rootDir,
			},
		);

		expect(result).toEqual({ content: source, rustfmtAvailable: false });
	});
});
