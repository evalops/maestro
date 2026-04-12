import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(
	rootDir,
	"packages/contracts/src/headless-protocol.manifest.json",
);
const protoPath = resolve(rootDir, "proto/maestro/v1/headless.proto");

const manifestToEnum = {
	serverRequestTypes: "ServerRequestType",
	serverRequestResolutions: "ServerRequestResolution",
	serverRequestResolvedBy: "ServerRequestResolvedBy",
	toolRetryDecisionActions: "ToolRetryDecisionAction",
	connectionRoles: "ConnectionRole",
	notificationTypes: "NotificationType",
	thinkingLevels: "ThinkingLevel",
	approvalModes: "ApprovalMode",
	errorTypes: "ErrorType",
	utilityOperations: "UtilityOperation",
	utilityCommandStreams: "UtilityCommandStream",
	utilityCommandShellModes: "UtilityCommandShellMode",
	utilityCommandTerminalModes: "UtilityCommandTerminalMode",
	utilityFileWatchChangeTypes: "UtilityFileWatchChangeType",
};

const manifestToEnvelope = {
	toAgentMessageTypes: "ToAgentEnvelope",
	fromAgentMessageTypes: "FromAgentEnvelope",
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

async function main() {
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	const protoSource = await readFile(protoPath, "utf8");
	const protoEnums = parseProtoEnums(protoSource);
	const protoVersion = parseProtoVersion(protoSource);
	const mismatches = [];

	if (manifest.protocolVersion !== protoVersion) {
		mismatches.push(
			`protocolVersion: manifest=${manifest.protocolVersion} proto=${protoVersion}`,
		);
	}

	for (const [manifestKey, enumName] of Object.entries(manifestToEnum)) {
		const manifestValues = manifest[manifestKey];
		const protoValues = protoEnums.get(enumName);
		if (!Array.isArray(manifestValues)) {
			throw new Error(`Manifest key ${manifestKey} is not an array`);
		}
		if (!protoValues) {
			throw new Error(`Missing enum ${enumName} in proto/maestro/v1/headless.proto`);
		}
		if (JSON.stringify(manifestValues) !== JSON.stringify(protoValues)) {
			mismatches.push(
				`${manifestKey}: manifest=${JSON.stringify(manifestValues)} proto=${JSON.stringify(protoValues)}`,
			);
		}
	}

	for (const [manifestKey, messageName] of Object.entries(manifestToEnvelope)) {
		const manifestValues = manifest[manifestKey];
		const protoValues = parseOneofFields(protoSource, messageName);
		if (!Array.isArray(manifestValues)) {
			throw new Error(`Manifest key ${manifestKey} is not an array`);
		}
		if (JSON.stringify(manifestValues) !== JSON.stringify(protoValues)) {
			mismatches.push(
				`${manifestKey}: manifest=${JSON.stringify(manifestValues)} proto=${JSON.stringify(protoValues)}`,
			);
		}
	}

	if (mismatches.length > 0) {
		throw new Error(
			`Headless protocol manifest is out of sync with proto:\n${mismatches.join("\n")}`,
		);
	}
}

await main();
