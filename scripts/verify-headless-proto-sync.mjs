import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const protoPath = resolve(rootDir, "proto/maestro/v1/headless.proto");
const payloadManifestPath = resolve(
	rootDir,
	"packages/contracts/src/headless-protocol-payloads.manifest.json",
);

const protoToExportKey = {
	ServerRequestType: "headlessServerRequestTypes",
	ServerRequestResolution: "headlessServerRequestResolutions",
	ServerRequestResolvedBy: "headlessServerRequestResolvedBy",
	ToolRetryDecisionAction: "headlessToolRetryDecisionActions",
	ConnectionRole: "headlessConnectionRoles",
	NotificationType: "headlessNotificationTypes",
	ThinkingLevel: "headlessThinkingLevels",
	ApprovalMode: "headlessApprovalModes",
	ErrorType: "headlessErrorTypes",
	UtilityOperation: "headlessUtilityOperations",
	UtilityCommandStream: "headlessUtilityCommandStreams",
	UtilityCommandShellMode: "headlessUtilityCommandShellModes",
	UtilityCommandTerminalMode: "headlessUtilityCommandTerminalModes",
	UtilityFileWatchChangeType: "headlessUtilityFileWatchChangeTypes",
};

function toEnumPrefix(enumName) {
	return enumName
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toUpperCase();
}

function parseProtoVersion(source) {
	const match = source.match(/protocol-version:\s*([0-9-]+)/);
	if (!match) {
		throw new Error("Missing protocol-version comment in proto/maestro/v1/headless.proto");
	}
	return match[1];
}

function parseProtoEnums(source) {
	const enums = new Map();
	const enumPattern = /enum\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
	for (const match of source.matchAll(enumPattern)) {
		const [, enumName, body] = match;
		const prefix = `${toEnumPrefix(enumName)}_`;
		const values = [];
		for (const line of body.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("//")) {
				continue;
			}
			const valueMatch = trimmed.match(/^([A-Z0-9_]+)\s*=\s*\d+;/);
			if (!valueMatch) {
				continue;
			}
			const identifier = valueMatch[1];
			if (identifier.endsWith("_UNSPECIFIED")) {
				continue;
			}
			if (!identifier.startsWith(prefix)) {
				throw new Error(`Enum value ${identifier} does not match prefix ${prefix}`);
			}
			values.push(identifier.slice(prefix.length).toLowerCase());
		}
		enums.set(enumName, values);
	}
	return enums;
}

function parseOneofFields(source, messageName) {
	const pattern = new RegExp(
		`message\\s+${messageName}\\s*\\{[\\s\\S]*?oneof\\s+payload\\s*\\{([\\s\\S]*?)\\n\\s*\\}\\n\\}`,
	);
	const match = source.match(pattern);
	if (!match) {
		throw new Error(`Missing oneof payload in ${messageName}`);
	}
	const values = [];
	for (const line of match[1].split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("//")) {
			continue;
		}
		const fieldMatch = trimmed.match(/^\w+\s+(\w+)\s*=\s*\d+;/);
		if (!fieldMatch) {
			continue;
		}
		values.push(fieldMatch[1]);
	}
	return values;
}

function collectEnumRefs(schema, refs = new Set()) {
	if (!schema || typeof schema !== "object") {
		return refs;
	}
	if (schema.kind === "enumRef" && typeof schema.name === "string") {
		refs.add(schema.name);
		return refs;
	}
	if (schema.kind === "object") {
		for (const value of Object.values(schema.properties ?? {})) {
			collectEnumRefs(value, refs);
		}
		return refs;
	}
	if (schema.kind === "array") {
		return collectEnumRefs(schema.items, refs);
	}
	if (schema.kind === "record") {
		return collectEnumRefs(schema.value, refs);
	}
	if (schema.kind === "union") {
		for (const variant of schema.variants ?? []) {
			collectEnumRefs(variant, refs);
		}
	}
	return refs;
}

async function main() {
	const protoSource = await readFile(protoPath, "utf8");
	const payloadManifest = JSON.parse(await readFile(payloadManifestPath, "utf8"));
	const protoEnums = parseProtoEnums(protoSource);
	parseProtoVersion(protoSource);

	for (const enumName of Object.keys(protoToExportKey)) {
		if (!protoEnums.has(enumName)) {
			throw new Error(`Missing enum ${enumName} in proto/maestro/v1/headless.proto`);
		}
	}

	parseOneofFields(protoSource, "ToAgentEnvelope");
	parseOneofFields(protoSource, "FromAgentEnvelope");

	const knownEnumRefs = new Set(Object.values(protoToExportKey));
	const sections = [
		payloadManifest.namedSchemas ?? {},
		payloadManifest.toAgentSchemas ?? {},
		payloadManifest.fromAgentSchemas ?? {},
		payloadManifest.runtimeSchemas ?? {},
	];
	const referencedEnumRefs = new Set();
	for (const section of sections) {
		for (const schema of Object.values(section)) {
			collectEnumRefs(schema, referencedEnumRefs);
		}
	}

	const unknownEnumRefs = Array.from(referencedEnumRefs).filter(
		(name) => !knownEnumRefs.has(name),
	);
	if (unknownEnumRefs.length > 0) {
		throw new Error(
			`Headless payload manifest references unknown enum exports: ${unknownEnumRefs.join(", ")}`,
		);
	}
}

await main();
