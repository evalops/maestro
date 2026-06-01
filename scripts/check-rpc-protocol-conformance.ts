#!/usr/bin/env tsx

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectCliEntrypoint } from "./direct-cli-entrypoint.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const defaultFixturePath = "test/fixtures/rpc/protocol-v1.json";

const requiredCommandTypes = new Set([
	"prompt",
	"abort",
	"get_messages",
	"get_state",
	"continue",
	"compact",
	"unknown",
]);

const requiredSurfaceAreas = new Set([
	"rpc-server-dispatch",
	"rpc-server-request-id-correlation",
	"rpc-client-launch",
	"rpc-type-union",
	"rpc-runtime-tests",
]);

type RpcProtocolCommand = {
	name?: string;
	type?: string;
	request?: unknown;
	response?: unknown;
};

type RpcProtocolSurface = {
	area?: string;
	path?: string;
	anchors?: unknown;
};

type RpcProtocolFixture = {
	version?: unknown;
	schema?: unknown;
	commands?: unknown;
	runtimeSurfaces?: unknown;
};

export function loadRpcProtocolConformanceFixture(
	fixturePath = defaultFixturePath,
): RpcProtocolFixture {
	return JSON.parse(readFileSync(resolve(root, fixturePath), "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pathStaysWithinRoot(rootPath: string, targetPath: string): boolean {
	const relativePath = relative(rootPath, targetPath);
	return (
		relativePath === "" ||
		(!relativePath.startsWith("..") && !isAbsolute(relativePath))
	);
}

function checkCommands(
	commands: unknown,
	failures: string[],
): RpcProtocolCommand[] {
	if (!Array.isArray(commands) || commands.length === 0) {
		failures.push("fixture must contain at least one RPC command");
		return [];
	}
	return commands as RpcProtocolCommand[];
}

function checkSurfaces(
	surfaces: unknown,
	failures: string[],
): RpcProtocolSurface[] {
	if (!Array.isArray(surfaces) || surfaces.length === 0) {
		failures.push("fixture must contain at least one runtime surface");
		return [];
	}
	return surfaces as RpcProtocolSurface[];
}

export function checkRpcProtocolConformance({
	fixture = loadRpcProtocolConformanceFixture(),
	rootDir = root,
}: {
	fixture?: RpcProtocolFixture;
	rootDir?: string;
} = {}): string[] {
	const failures: string[] = [];
	if (fixture.version !== 1) {
		failures.push("fixture version must be 1");
	}
	if (fixture.schema !== "evalops.maestro.rpc-protocol-conformance.v1") {
		failures.push("fixture schema must be evalops.maestro.rpc-protocol-conformance.v1");
	}

	const commandTypes = new Set<string>();
	for (const [index, command] of checkCommands(
		fixture.commands,
		failures,
	).entries()) {
		const label = command.name ?? command.type ?? `command #${index + 1}`;
		if (!command.type || typeof command.type !== "string") {
			failures.push(`${label} is missing command type`);
		} else {
			commandTypes.add(command.type);
		}
		if (!isRecord(command.request)) {
			failures.push(`${label} must define a request object`);
			continue;
		}
		if (typeof command.request.type !== "string") {
			failures.push(`${label} request must define a string type`);
		}
		if (
			command.type !== "unknown" &&
			typeof command.type === "string" &&
			command.request.type !== command.type
		) {
			failures.push(
				`${label} request type ${JSON.stringify(command.request.type)} does not match command type ${JSON.stringify(command.type)}`,
			);
		}
		if (!isRecord(command.response)) {
			failures.push(`${label} must define a response object`);
			continue;
		}
		if (
			command.response.echoesRequestId === true &&
			typeof command.request.id !== "string"
		) {
			failures.push(`${label} requires a string request id`);
		}
		if (
			command.response.echoesRequestId === true &&
			typeof command.response.type !== "string"
		) {
			failures.push(`${label} correlated responses must define response.type`);
		}
		if (
			command.response.requiredFields !== undefined &&
			(!Array.isArray(command.response.requiredFields) ||
				!command.response.requiredFields.every(
					(field) => typeof field === "string" && field.length > 0,
				))
		) {
			failures.push(`${label} response.requiredFields must be a string array`);
		}
	}

	for (const requiredType of requiredCommandTypes) {
		if (!commandTypes.has(requiredType)) {
			failures.push(`fixture is missing RPC command ${requiredType}`);
		}
	}

	const rootPath = resolve(rootDir);
	const rootRealPath = realpathSync(rootPath);
	const surfaceAreas = new Set<string>();
	for (const [index, surface] of checkSurfaces(
		fixture.runtimeSurfaces,
		failures,
	).entries()) {
		const label = surface.area ?? `runtime surface #${index + 1}`;
		if (!surface.area) {
			failures.push(`${label} is missing area`);
		} else {
			surfaceAreas.add(surface.area);
		}
		if (!surface.path) {
			failures.push(`${label} is missing path`);
			continue;
		}
		if (!Array.isArray(surface.anchors) || surface.anchors.length === 0) {
			failures.push(`${label}: ${surface.path} must list anchors`);
			continue;
		}
		if (!surface.anchors.every((anchor) => typeof anchor === "string")) {
			failures.push(`${label}: ${surface.path} anchors must be strings`);
			continue;
		}
		const absolutePath = resolve(rootPath, surface.path);
		if (!pathStaysWithinRoot(rootPath, absolutePath)) {
			failures.push(`${label}: ${surface.path} escapes repository root`);
			continue;
		}
		if (!existsSync(absolutePath)) {
			failures.push(`${label}: ${surface.path} points at missing file`);
			continue;
		}
		const realPath = realpathSync(absolutePath);
		if (!pathStaysWithinRoot(rootRealPath, realPath)) {
			failures.push(`${label}: ${surface.path} escapes repository root`);
			continue;
		}
		const source = readFileSync(realPath, "utf8");
		for (const anchor of surface.anchors) {
			if (!source.includes(anchor)) {
				failures.push(
					`${label}: ${surface.path} is missing anchor ${JSON.stringify(anchor)}`,
				);
			}
		}
	}

	for (const requiredArea of requiredSurfaceAreas) {
		if (!surfaceAreas.has(requiredArea)) {
			failures.push(`fixture is missing runtime surface ${requiredArea}`);
		}
	}

	return failures;
}

function main(): void {
	const fixturePath = process.argv[2] ?? defaultFixturePath;
	const failures = checkRpcProtocolConformance({
		fixture: loadRpcProtocolConformanceFixture(fixturePath),
		rootDir: root,
	});
	if (failures.length > 0) {
		console.error("RPC protocol conformance failed:");
		for (const failure of failures) {
			console.error(`  - ${failure}`);
		}
		process.exit(1);
	}
	console.log("RPC protocol conformance passed");
}

if (isDirectCliEntrypoint(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
