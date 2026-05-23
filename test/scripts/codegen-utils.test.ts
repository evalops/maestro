import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatRustWithRustfmt } from "../../scripts/codegen-utils.mjs";

const envName = "HEADLESS_PROTOCOL_RUSTFMT";
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
	it.each(["", "  ", "0", "false", "no", "off", "none", "skip", "disabled"])(
		"treats %s as an explicit formatter opt-out",
		(value) => {
			const rootDir = makeTempDir();
			process.env[envName] = value;
			const source = 'pub fn generated(){println!("ok");}\n';

			const result = formatRustWithRustfmt(
				source,
				join(rootDir, "generated.rs"),
				{
					rootDir,
					label: "generated Rust fixture",
					envNames: [envName],
				},
			);

			expect(result).toEqual({ content: source, rustfmtAvailable: false });
		},
	);

	it("allows MAESTRO_RUSTFMT to disable generated Rust formatting", () => {
		const rootDir = makeTempDir();
		process.env.MAESTRO_RUSTFMT = "";
		const source = 'pub fn generated(){println!("ok");}\n';

		const result = formatRustWithRustfmt(
			source,
			join(rootDir, "generated.rs"),
			{
				rootDir,
				label: "generated Rust fixture",
			},
		);

		expect(result).toEqual({ content: source, rustfmtAvailable: false });
	});
});
