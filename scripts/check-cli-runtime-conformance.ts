#!/usr/bin/env tsx

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../src/cli/args.js";
import { isDirectCliEntrypoint } from "./direct-cli-entrypoint.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const defaultFixturePath = "test/fixtures/cli-runtime/conformance-v1.json";

type ParserCase = {
	name?: string;
	argv?: unknown;
	expect?: Record<string, unknown>;
	absent?: unknown;
};

type RuntimeSurface = {
	area?: string;
	path?: string;
	anchors?: unknown;
};

type CliRuntimeConformanceFixture = {
	version?: unknown;
	parserCases?: unknown;
	runtimeSurfaces?: unknown;
};

export function loadCliRuntimeConformanceFixture(
	fixturePath = defaultFixturePath,
): CliRuntimeConformanceFixture {
	const absolutePath = resolve(root, fixturePath);
	return JSON.parse(readFileSync(absolutePath, "utf8"));
}

function display(value: unknown): string {
	if (value === undefined) {
		return "undefined";
	}
	return JSON.stringify(value);
}

function sameJsonValue(actual: unknown, expected: unknown): boolean {
	return JSON.stringify(actual) === JSON.stringify(expected);
}

function checkedParserCases(
	fixture: CliRuntimeConformanceFixture,
	failures: string[],
): ParserCase[] {
	if (!Array.isArray(fixture.parserCases) || fixture.parserCases.length === 0) {
		failures.push("fixture must contain at least one parser case");
		return [];
	}
	return fixture.parserCases as ParserCase[];
}

function checkedRuntimeSurfaces(
	fixture: CliRuntimeConformanceFixture,
	failures: string[],
): RuntimeSurface[] {
	if (
		!Array.isArray(fixture.runtimeSurfaces) ||
		fixture.runtimeSurfaces.length === 0
	) {
		failures.push("fixture must contain at least one runtime surface");
		return [];
	}
	return fixture.runtimeSurfaces as RuntimeSurface[];
}

export function checkCliRuntimeConformance({
	fixture = loadCliRuntimeConformanceFixture(),
	rootDir = root,
}: {
	fixture?: CliRuntimeConformanceFixture;
	rootDir?: string;
} = {}): string[] {
	const failures: string[] = [];
	if (fixture.version !== 1) {
		failures.push("fixture version must be 1");
	}

	for (const [index, parserCase] of checkedParserCases(
		fixture,
		failures,
	).entries()) {
		const name = parserCase.name ?? `parser case #${index + 1}`;
		if (!Array.isArray(parserCase.argv)) {
			failures.push(`${name} must define argv as an array`);
			continue;
		}
		if (!parserCase.argv.every((arg) => typeof arg === "string")) {
			failures.push(`${name} argv entries must be strings`);
			continue;
		}
		if (!parserCase.expect || typeof parserCase.expect !== "object") {
			failures.push(`${name} must define expected fields`);
			continue;
		}

		const actual = parseArgs(parserCase.argv);
		for (const [field, expected] of Object.entries(parserCase.expect)) {
			const actualValue = actual[field as keyof typeof actual];
			if (!sameJsonValue(actualValue, expected)) {
				failures.push(
					`${name} expected ${field}=${display(expected)} but got ${display(actualValue)}`,
				);
			}
		}

		if (parserCase.absent !== undefined) {
			if (
				!Array.isArray(parserCase.absent) ||
				!parserCase.absent.every((field) => typeof field === "string")
			) {
				failures.push(`${name} absent fields must be string array`);
				continue;
			}
			for (const field of parserCase.absent) {
				const actualValue = actual[field as keyof typeof actual];
				if (actualValue !== undefined) {
					failures.push(
						`${name} expected ${field} to be absent but got ${display(actualValue)}`,
					);
				}
			}
		}
	}

	const runtimeSurfaces = checkedRuntimeSurfaces(fixture, failures);
	const areas = new Set<string>();
	for (const [index, surface] of runtimeSurfaces.entries()) {
		const area = surface.area ?? `runtime surface #${index + 1}`;
		if (!surface.area) {
			failures.push(`${area} is missing area`);
		} else {
			areas.add(surface.area);
		}
		if (!surface.path) {
			failures.push(`${area} is missing path`);
			continue;
		}
		if (!Array.isArray(surface.anchors) || surface.anchors.length === 0) {
			failures.push(`${area}: ${surface.path} must list anchors`);
			continue;
		}
		if (!surface.anchors.every((anchor) => typeof anchor === "string")) {
			failures.push(`${area}: ${surface.path} anchors must be strings`);
			continue;
		}

		const absolutePath = join(rootDir, surface.path);
		if (!existsSync(absolutePath)) {
			failures.push(`${area}: ${surface.path} points at missing file`);
			continue;
		}
		const source = readFileSync(absolutePath, "utf8");
		for (const anchor of surface.anchors) {
			if (!source.includes(anchor)) {
				failures.push(
					`${area}: ${surface.path} is missing anchor ${JSON.stringify(anchor)}`,
				);
			}
		}
	}

	for (const requiredArea of [
		"cli-help",
		"cli-mode-selection",
		"cli-parser",
		"rpc-stdio-protocol",
	]) {
		if (!areas.has(requiredArea)) {
			failures.push(`fixture is missing runtime surface ${requiredArea}`);
		}
	}

	return failures;
}

function main(): void {
	const fixturePath = process.argv[2] ?? defaultFixturePath;
	const failures = checkCliRuntimeConformance({
		fixture: loadCliRuntimeConformanceFixture(fixturePath),
		rootDir: root,
	});
	if (failures.length > 0) {
		console.error("CLI runtime conformance failed:");
		for (const failure of failures) {
			console.error(`  - ${failure}`);
		}
		process.exit(1);
	}
	console.log("CLI runtime conformance passed");
}

if (isDirectCliEntrypoint(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
