import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	MaestroAppServerClientRequestSchema,
	MaestroAppServerResponseSchema,
	MaestroAppServerServerNotificationSchema,
	maestroAppServerClientMethods,
	maestroAppServerExternalAgentArtifactKinds,
	maestroAppServerExternalAgentImportScopes,
	maestroAppServerExternalAgentImportStatuses,
	maestroAppServerNetworkGovernanceStatuses,
	maestroAppServerPluginBundleScopes,
	maestroAppServerProtocolModeIds,
	maestroAppServerProtocolVersion,
	maestroAppServerRemoteControlLeaseStates,
	maestroAppServerRemoteControlStatuses,
	maestroAppServerSandboxProofModes,
	maestroAppServerSandboxTypes,
	maestroAppServerServerMethods,
	maestroAppServerSupportedProtocolVersions,
	maestroAppServerThreadStatuses,
	maestroAppServerTurnStatuses,
} from "../packages/contracts/src/maestro-app-server.js";
import * as appServerContracts from "../packages/contracts/src/maestro-app-server.js";

const check = process.argv.includes("--check");
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const protocolFixturePath = resolve(
	rootDir,
	"packages/contracts/schema/app-server/protocol.json",
);
const payloadSchemaFixturePath = resolve(
	rootDir,
	"packages/contracts/schema/app-server/payload-schemas.json",
);

function stableJson(value: unknown): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

function formatJson(content: string, path: string): string {
	const biome = resolve(rootDir, "node_modules/.bin/biome");
	if (!existsSync(biome)) {
		return content;
	}
	const result = spawnSync(biome, ["format", "--stdin-file-path", path], {
		cwd: rootDir,
		encoding: "utf8",
		input: content,
	});
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout);
	}
	return result.stdout;
}

function sortObject(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortObject);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, sortObject(entry)]),
		);
	}
	return value;
}

function collectNamedSchemas(): Record<string, unknown> {
	const schemas: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(appServerContracts)) {
		if (
			name.startsWith("MaestroAppServer") &&
			name.endsWith("Schema") &&
			value &&
			typeof value === "object" &&
			!Array.isArray(value)
		) {
			schemas[name] = sortObject(value);
		}
	}
	return schemas;
}

const protocolFixture = {
	protocolVersion: maestroAppServerProtocolVersion,
	supportedProtocolVersions: [...maestroAppServerSupportedProtocolVersions],
	clientMethods: [...maestroAppServerClientMethods],
	serverMethods: [...maestroAppServerServerMethods],
	threadStatuses: [...maestroAppServerThreadStatuses],
	turnStatuses: [...maestroAppServerTurnStatuses],
	protocolModeIds: [...maestroAppServerProtocolModeIds],
	networkGovernanceStatuses: [...maestroAppServerNetworkGovernanceStatuses],
	sandboxTypes: [...maestroAppServerSandboxTypes],
	sandboxProofModes: [...maestroAppServerSandboxProofModes],
	externalAgentArtifactKinds: [
		...maestroAppServerExternalAgentArtifactKinds,
	],
	externalAgentImportStatuses: [
		...maestroAppServerExternalAgentImportStatuses,
	],
	externalAgentImportScopes: [...maestroAppServerExternalAgentImportScopes],
	pluginBundleScopes: [...maestroAppServerPluginBundleScopes],
	remoteControlStatuses: [...maestroAppServerRemoteControlStatuses],
	remoteControlLeaseStates: [...maestroAppServerRemoteControlLeaseStates],
};

const payloadSchemaFixture = {
	namedSchemas: collectNamedSchemas(),
	entrypoints: {
		clientRequest: "MaestroAppServerClientRequestSchema",
		response: "MaestroAppServerResponseSchema",
		serverNotification: "MaestroAppServerServerNotificationSchema",
	},
	smokeSchemas: {
		MaestroAppServerClientRequestSchema: sortObject(
			MaestroAppServerClientRequestSchema,
		),
		MaestroAppServerResponseSchema: sortObject(MaestroAppServerResponseSchema),
		MaestroAppServerServerNotificationSchema: sortObject(
			MaestroAppServerServerNotificationSchema,
		),
	},
};

async function checkOrWrite(path: string, content: string): Promise<boolean> {
	if (!check) {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, "utf8");
		return true;
	}
	const current = await readFile(path, "utf8").catch(() => null);
	if (current !== content) {
		console.error(`app-server schema fixture is out of date: ${path}`);
		return false;
	}
	return true;
}

const targets = [
	{
		path: protocolFixturePath,
		content: formatJson(stableJson(protocolFixture), protocolFixturePath),
	},
	{
		path: payloadSchemaFixturePath,
		content: formatJson(
			stableJson(payloadSchemaFixture),
			payloadSchemaFixturePath,
		),
	},
];

const results = await Promise.all(
	targets.map((target) => checkOrWrite(target.path, target.content)),
);
if (check && results.some((result) => !result)) {
	process.exitCode = 1;
}
