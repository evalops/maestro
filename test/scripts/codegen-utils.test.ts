import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	formatRustWithRustfmt,
	rustGeneratedMatches,
} from "../../scripts/codegen-utils.mjs";

const envName = "HEADLESS_PROTOCOL_RUSTFMT";
const managedEnvNames = [
	envName,
	"SESSION_WIRE_FORMAT_RUSTFMT",
	"MAESTRO_RUSTFMT",
	"MAESTRO_TEST_RUSTFMT",
];
const previousEnv = new Map(
	managedEnvNames.map((name) => [name, process.env[name]]),
);
const tempDirs: string[] = [];

afterEach(() => {
	for (const name of managedEnvNames) {
		restoreEnv(name, previousEnv.get(name));
	}
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

	it("matches generated Rust when rustfmt is intentionally unavailable", () => {
		const rootDir = makeTempDir();
		process.env.MAESTRO_RUSTFMT = "off";
		const source = 'pub const VALUES:&[&str]=&["a",];\n';
		const formatted = 'pub const VALUES: &[&str] = &["a"];\n';

		const output = formatRustWithRustfmt(source, join(rootDir, "out.rs"), {
			rootDir,
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
	});

	it("treats per-script rustfmt off values as an explicit formatter opt-out", () => {
		const tempDir = makeTempDir();
		process.env.HEADLESS_PROTOCOL_RUSTFMT = "off";
		const source = "pub fn generated(){}\n";
		const result = formatRustWithRustfmt(
			source,
			join(tempDir, "generated.rs"),
			{
				rootDir: tempDir,
				label: "generated Rust fixture",
				envNames: ["HEADLESS_PROTOCOL_RUSTFMT"],
			},
		);

		expect(result).toEqual({
			content: source,
			rustfmtAvailable: false,
		});
	});

	it("treats MAESTRO_RUSTFMT off values as an explicit formatter opt-out", () => {
		const tempDir = makeTempDir();
		process.env.MAESTRO_RUSTFMT = "off";
		const source = "pub fn generated(){}\n";
		const result = formatRustWithRustfmt(
			source,
			join(tempDir, "generated.rs"),
			{
				rootDir: tempDir,
				label: "generated Rust fixture",
			},
		);

		expect(result).toEqual({
			content: source,
			rustfmtAvailable: false,
		});
	});
});

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		Reflect.deleteProperty(process.env, name);
		return;
	}
	process.env[name] = value;
}
