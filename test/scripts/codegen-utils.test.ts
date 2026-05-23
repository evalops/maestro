import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatRustWithRustfmt } from "../../scripts/codegen-utils.mjs";

const envName = "MAESTRO_TEST_RUSTFMT";
const tempDirs: string[] = [];

afterEach(() => {
	delete process.env[envName];
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
	it("honors an explicit env opt-out for generated Rust formatting", () => {
		const rootDir = makeTempDir();
		process.env[envName] = "off";
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
	});
});
