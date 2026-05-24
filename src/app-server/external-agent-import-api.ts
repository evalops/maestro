import { Buffer } from "node:buffer";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, extname, join, posix, resolve, win32 } from "node:path";
import type {
	MaestroAppServerExternalAgentImportResult,
	MaestroAppServerExternalAgentImportScope,
	MaestroAppServerExternalAgentImportedArtifact,
} from "@evalops/contracts";
import { parse as parseTOML, stringify as stringifyTOML } from "smol-toml";
import { PATHS } from "../config/constants.js";
import { getWritablePackageConfigPath } from "../config/toml-config.js";
import { clearConfigCache } from "../config/toml-config.js";
import {
	getProjectHooksConfigPath,
	getUserHooksConfigPath,
} from "../hooks/config.js";
import {
	type WritableMcpScope,
	addMcpServersToConfig,
	inferRemoteMcpTransport,
	validateMcpServersForConfig,
} from "../mcp/config.js";
import { type McpServerInput, mcpServerSchema } from "../mcp/schema.js";
import {
	type SessionEntry,
	normalizeSessionEntry,
	tryParseSessionEntry,
} from "../session/types.js";

type UnknownRecord = Record<string, unknown>;
const PORTABLE_SESSION_EXPORT_FORMAT = "maestro-session-export.v1";

export class MaestroAppServerExternalAgentImportError extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
		this.name = "MaestroAppServerExternalAgentImportError";
	}
}

export interface MaestroAppServerExternalAgentSessionImporter {
	importSessionEntries?: (entries: SessionEntry[]) => {
		sessionFile: string;
		sessionId: string;
		importedCount: number;
	};
	importPortableSession?: (path: string) => {
		sessionFile: string;
		sessionId: string;
		importedCount: number;
	};
}

export interface MaestroAppServerExternalAgentImport {
	importBundle(
		params?: UnknownRecord,
	): Promise<MaestroAppServerExternalAgentImportResult>;
}

export interface MaestroAppServerExternalAgentImportOptions {
	store?: MaestroAppServerExternalAgentSessionImporter;
	projectRoot?: string;
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

export function normalizeExternalAgentImportParams(
	value: unknown,
): UnknownRecord {
	if (value === undefined || value === null) {
		return {};
	}
	if (!isRecord(value)) {
		throw new MaestroAppServerExternalAgentImportError(
			-32602,
			"Invalid params",
		);
	}
	return value;
}

function artifactScope(
	artifact: UnknownRecord,
	fallback: MaestroAppServerExternalAgentImportScope,
): MaestroAppServerExternalAgentImportScope {
	const scope = stringValue(artifact.scope);
	if (scope === "project" || scope === "local" || scope === "user") {
		return scope;
	}
	return fallback;
}

function requireArtifacts(params: UnknownRecord): UnknownRecord[] {
	const artifacts = params.artifacts;
	if (!Array.isArray(artifacts)) {
		throw new MaestroAppServerExternalAgentImportError(
			-32602,
			"External agent import requires artifacts",
		);
	}
	if (artifacts.some((artifact) => !isRecord(artifact))) {
		throw new MaestroAppServerExternalAgentImportError(
			-32602,
			"External agent import artifacts must be objects",
		);
	}
	return artifacts;
}

function importSource(params: UnknownRecord): { name: string; type?: string } {
	const source = isRecord(params.source) ? params.source : {};
	return {
		name: stringValue(source.name) ?? "external-agent",
		type: stringValue(source.type),
	};
}

function safeSkillName(value: unknown): string {
	const name = stringValue(value);
	if (!name || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
		throw new MaestroAppServerExternalAgentImportError(
			-32602,
			"Skill artifact requires a safe skill name",
		);
	}
	return name;
}

function safeRelativePath(value: unknown): string {
	const relativePath = stringValue(value);
	if (!relativePath) {
		throw new MaestroAppServerExternalAgentImportError(
			-32602,
			"Imported file requires a relative path",
		);
	}
	const slashPath = relativePath.replaceAll("\\", "/");
	const normalized = posix.normalize(slashPath);
	const winNormalized = win32.normalize(relativePath);
	if (
		posix.isAbsolute(normalized) ||
		win32.isAbsolute(relativePath) ||
		/^[A-Za-z]:/.test(relativePath) ||
		normalized === ".." ||
		normalized.startsWith("../") ||
		normalized.includes("/../") ||
		winNormalized === ".." ||
		winNormalized.startsWith("..\\") ||
		winNormalized.includes("\\..\\")
	) {
		throw new MaestroAppServerExternalAgentImportError(
			-32602,
			"Imported file path must stay inside its target directory",
		);
	}
	return normalized;
}

function artifactMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function hasOwn(record: UnknownRecord, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

function readJsonObject(path: string): UnknownRecord {
	if (!existsSync(path)) {
		return {};
	}
	const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	return isRecord(parsed) ? parsed : {};
}

function writeJsonObject(path: string, value: UnknownRecord): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function mergeRecords(
	base: UnknownRecord,
	incoming: UnknownRecord,
): UnknownRecord {
	const merged: UnknownRecord = { ...base };
	for (const [key, value] of Object.entries(incoming)) {
		const current = merged[key];
		if (isRecord(current) && isRecord(value)) {
			merged[key] = mergeRecords(current, value);
		} else {
			merged[key] = value;
		}
	}
	return merged;
}

function configContent(artifact: UnknownRecord): UnknownRecord {
	if (isRecord(artifact.values)) {
		return artifact.values;
	}
	const content = stringValue(artifact.content);
	if (!content) {
		throw new MaestroAppServerExternalAgentImportError(
			-32602,
			"Config artifact requires values or TOML content",
		);
	}
	const parsed = parseTOML(content) as unknown;
	if (!isRecord(parsed)) {
		throw new MaestroAppServerExternalAgentImportError(
			-32602,
			"Config TOML must parse to an object",
		);
	}
	return parsed;
}

function writeConfigImport(
	artifact: UnknownRecord,
	projectRoot: string,
	dryRun: boolean,
): MaestroAppServerExternalAgentImportedArtifact {
	const scope = artifactScope(artifact, "local");
	const path = getWritablePackageConfigPath(scope, projectRoot);
	const incoming = configContent(artifact);
	const existing = existsSync(path)
		? (parseTOML(readFileSync(path, "utf8")) as unknown)
		: {};
	const merged = mergeRecords(isRecord(existing) ? existing : {}, incoming);
	if (!dryRun) {
		mkdirSync(dirname(path), { recursive: true });
		const rendered = stringifyTOML(merged).trim();
		writeFileSync(path, rendered ? `${rendered}\n` : "", "utf8");
		clearConfigCache();
	}
	return {
		kind: "config",
		status: dryRun ? "planned" : "imported",
		scope,
		path,
		message: dryRun ? "Config TOML merge planned" : "Config TOML merged",
	};
}

function hooksContent(artifact: UnknownRecord): UnknownRecord {
	if (isRecord(artifact.config)) {
		return artifact.config;
	}
	if (isRecord(artifact.hooks)) {
		return { hooks: artifact.hooks };
	}
	throw new MaestroAppServerExternalAgentImportError(
		-32602,
		"Hooks artifact requires config or hooks",
	);
}

function mergeHooksConfig(
	existing: UnknownRecord,
	incoming: UnknownRecord,
): UnknownRecord {
	const existingHooks = isRecord(existing.hooks) ? existing.hooks : {};
	const incomingHooks = isRecord(incoming.hooks) ? incoming.hooks : {};
	const hooks: UnknownRecord = { ...existingHooks };
	for (const [eventType, matchers] of Object.entries(incomingHooks)) {
		hooks[eventType] = [
			...(Array.isArray(existingHooks[eventType])
				? existingHooks[eventType]
				: []),
			...(Array.isArray(matchers) ? matchers : []),
		];
	}
	return mergeRecords(mergeRecords(existing, incoming), { hooks });
}

function hooksConfigPath(
	scope: MaestroAppServerExternalAgentImportScope,
	projectRoot: string,
): string {
	if (scope === "user") {
		return getUserHooksConfigPath();
	}
	return getProjectHooksConfigPath(projectRoot);
}

function writeHooksImport(
	artifact: UnknownRecord,
	projectRoot: string,
	dryRun: boolean,
): MaestroAppServerExternalAgentImportedArtifact {
	const scope = artifactScope(artifact, "project");
	const path = hooksConfigPath(scope, projectRoot);
	const incoming = hooksContent(artifact);
	const existing = readJsonObject(path);
	if (!dryRun) {
		writeJsonObject(path, mergeHooksConfig(existing, incoming));
	}
	return {
		kind: "hooks",
		status: dryRun ? "planned" : "imported",
		scope,
		path,
		message: dryRun ? "Hooks config merge planned" : "Hooks config merged",
	};
}

function mcpServers(artifact: UnknownRecord): UnknownRecord[] {
	if (Array.isArray(artifact.servers)) {
		if (!artifact.servers.every(isRecord)) {
			throw new MaestroAppServerExternalAgentImportError(
				-32602,
				"MCP artifact servers must be objects",
			);
		}
		return artifact.servers;
	}
	if (hasOwn(artifact, "server")) {
		if (!isRecord(artifact.server)) {
			throw new MaestroAppServerExternalAgentImportError(
				-32602,
				"MCP artifact server must be an object",
			);
		}
		return [artifact.server];
	}
	return [];
}

function validateMcpServerForImport(
	server: UnknownRecord,
	name: string,
): McpServerInput & { name: string } {
	return mcpServerSchema.parse({
		...server,
		name,
		transport:
			server.transport ??
			(typeof server.url === "string"
				? inferRemoteMcpTransport(server.url)
				: "stdio"),
	});
}

function writeMcpImport(
	artifact: UnknownRecord,
	projectRoot: string,
	dryRun: boolean,
): MaestroAppServerExternalAgentImportedArtifact[] {
	const scope = artifactScope(artifact, "local") as WritableMcpScope;
	const servers = mcpServers(artifact);
	if (servers.length === 0) {
		throw new MaestroAppServerExternalAgentImportError(
			-32602,
			"MCP artifact requires a server or servers",
		);
	}
	const validatedServers = servers.map((server) => {
		const name = stringValue(server.name) ?? "(unnamed)";
		return validateMcpServerForImport(server, name);
	});
	const result = dryRun
		? validateMcpServersForConfig({
				projectRoot,
				scope,
				servers: validatedServers,
			})
		: addMcpServersToConfig({
				projectRoot,
				scope,
				servers: validatedServers,
			});
	const imported: MaestroAppServerExternalAgentImportedArtifact[] = [];
	for (const validatedServer of validatedServers) {
		if (dryRun) {
			imported.push({
				kind: "mcp",
				status: "planned",
				scope,
				id: validatedServer.name,
				path: result.path,
				message: "MCP server import planned",
			});
			continue;
		}
		imported.push({
			kind: "mcp",
			status: "imported",
			scope,
			id: validatedServer.name,
			path: result.path,
			message: "MCP server imported",
		});
	}
	return imported;
}

function skillRootPath(
	scope: MaestroAppServerExternalAgentImportScope,
	projectRoot: string,
): string {
	return scope === "user"
		? join(PATHS.MAESTRO_HOME, "skills")
		: join(projectRoot, ".maestro", "skills");
}

function fileContent(file: UnknownRecord): string | Buffer {
	const content = typeof file.content === "string" ? file.content : undefined;
	if (content !== undefined) {
		return content;
	}
	const contentBase64 =
		typeof file.contentBase64 === "string" ? file.contentBase64 : undefined;
	if (contentBase64 !== undefined) {
		const compact = contentBase64.replaceAll(/\s/g, "");
		if (
			compact.length === 0 ||
			compact.length % 4 !== 0 ||
			!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)
		) {
			throw new MaestroAppServerExternalAgentImportError(
				-32602,
				"Skill file contentBase64 is not valid base64",
			);
		}
		return Buffer.from(compact, "base64");
	}
	throw new MaestroAppServerExternalAgentImportError(
		-32602,
		"Skill file requires content or contentBase64",
	);
}

function writeSkillImport(
	artifact: UnknownRecord,
	projectRoot: string,
	dryRun: boolean,
): MaestroAppServerExternalAgentImportedArtifact {
	const scope = artifactScope(artifact, "project");
	const name = safeSkillName(artifact.name);
	const files = Array.isArray(artifact.files) ? artifact.files : [];
	if (!files.every(isRecord)) {
		throw new MaestroAppServerExternalAgentImportError(
			-32602,
			"Skill artifact files must be objects",
		);
	}
	if (files.length === 0) {
		throw new MaestroAppServerExternalAgentImportError(
			-32602,
			"Skill artifact requires files",
		);
	}
	if (!files.some((file) => safeRelativePath(file.path) === "SKILL.md")) {
		throw new MaestroAppServerExternalAgentImportError(
			-32602,
			"Skill artifact requires SKILL.md",
		);
	}
	const targetDir = join(skillRootPath(scope, projectRoot), name);
	const plannedFiles = files.map((file) => ({
		relativePath: safeRelativePath(file.path),
		content: fileContent(file),
	}));
	if (!dryRun) {
		const skillRoot = dirname(targetDir);
		mkdirSync(skillRoot, { recursive: true });
		let stagingDir: string | undefined = mkdtempSync(
			join(skillRoot, `.${name}-import-`),
		);
		let backupDir: string | undefined;
		let promoted = false;
		try {
			for (const file of plannedFiles) {
				const stagedPath = join(stagingDir, file.relativePath);
				mkdirSync(dirname(stagedPath), { recursive: true });
				if (typeof file.content === "string") {
					writeFileSync(stagedPath, file.content, "utf8");
				} else {
					writeFileSync(stagedPath, file.content);
				}
			}
			if (existsSync(targetDir)) {
				backupDir = mkdtempSync(join(skillRoot, `.${name}-backup-`));
				rmSync(backupDir, { recursive: true, force: true });
				renameSync(targetDir, backupDir);
			}
			try {
				renameSync(stagingDir, targetDir);
				promoted = true;
			} catch (error) {
				if (backupDir && !existsSync(targetDir)) {
					try {
						renameSync(backupDir, targetDir);
						backupDir = undefined;
					} catch {
						// Leave the backup in place rather than deleting the previous skill.
					}
				}
				throw error;
			}
			stagingDir = undefined;
			if (backupDir) {
				rmSync(backupDir, { recursive: true, force: true });
				backupDir = undefined;
			}
		} finally {
			if (stagingDir) {
				rmSync(stagingDir, { recursive: true, force: true });
			}
			if (backupDir && promoted) {
				rmSync(backupDir, { recursive: true, force: true });
			}
		}
	}
	return {
		kind: "skill",
		status: dryRun ? "planned" : "imported",
		scope,
		id: name,
		path: targetDir,
		message: dryRun ? "Skill file import planned" : "Skill files imported",
	};
}

function validatedSessionEntries(value: unknown): SessionEntry[] {
	if (!Array.isArray(value)) {
		throw new MaestroAppServerExternalAgentImportError(
			-32602,
			"Session artifact entries must be an array",
		);
	}
	const entries = value.map((entry) =>
		normalizeSessionEntry(structuredClone(entry)),
	);
	if (entries.some((entry) => entry === null)) {
		throw new MaestroAppServerExternalAgentImportError(
			-32602,
			"Session artifact entries must contain valid session entries",
		);
	}
	if (entries.length === 0) {
		throw new MaestroAppServerExternalAgentImportError(
			-32602,
			"Imported session file is empty or unreadable.",
		);
	}
	if (!entries.some((entry) => entry?.type === "session")) {
		throw new MaestroAppServerExternalAgentImportError(
			-32602,
			"Imported session file is missing a session header.",
		);
	}
	return entries as SessionEntry[];
}

function validatePortableSessionPath(sourcePath: string): string {
	const resolvedSource = resolve(sourcePath);
	if (!existsSync(resolvedSource)) {
		throw new MaestroAppServerExternalAgentImportError(
			-32602,
			`Session file not found: ${resolvedSource}`,
		);
	}
	if (!statSync(resolvedSource).isFile()) {
		throw new MaestroAppServerExternalAgentImportError(
			-32602,
			`Session path is not a file: ${resolvedSource}`,
		);
	}
	return resolvedSource;
}

function validatePortableSessionJsonExport(sourcePath: string): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(sourcePath, "utf8"));
	} catch (error) {
		throw new MaestroAppServerExternalAgentImportError(
			-32602,
			`Portable session export is not valid JSON: ${artifactMessage(error)}`,
		);
	}
	if (!isRecord(parsed)) {
		throw new MaestroAppServerExternalAgentImportError(
			-32602,
			"Portable session export must be a JSON object.",
		);
	}
	if (parsed.format !== PORTABLE_SESSION_EXPORT_FORMAT) {
		throw new MaestroAppServerExternalAgentImportError(
			-32602,
			`Portable session export format must be ${PORTABLE_SESSION_EXPORT_FORMAT}.`,
		);
	}
	if (Array.isArray(parsed.entries)) {
		validatedSessionEntries(parsed.entries);
		return;
	}
	if (Array.isArray(parsed.sessions) && parsed.sessions.length > 0) {
		for (const [index, session] of parsed.sessions.entries()) {
			if (!isRecord(session)) {
				throw new MaestroAppServerExternalAgentImportError(
					-32602,
					`Portable session export contains an invalid bundled session at index ${index}.`,
				);
			}
			if (typeof session.sessionId !== "string") {
				throw new MaestroAppServerExternalAgentImportError(
					-32602,
					`Portable session export is missing a sessionId for bundled session ${index}.`,
				);
			}
			if (!Array.isArray(session.entries)) {
				throw new MaestroAppServerExternalAgentImportError(
					-32602,
					`Portable session export is missing entries for bundled session ${session.sessionId}.`,
				);
			}
			validatedSessionEntries(session.entries);
		}
		return;
	}
	throw new MaestroAppServerExternalAgentImportError(
		-32602,
		"Portable session export is missing both entries and bundled sessions.",
	);
}

function validatePortableSessionJsonl(sourcePath: string): void {
	const contents = readFileSync(sourcePath, "utf8").trim();
	const entries = contents
		? contents
				.split("\n")
				.map((line) => tryParseSessionEntry(line))
				.filter((entry): entry is SessionEntry => Boolean(entry))
		: [];
	validatedSessionEntries(entries);
}

function validatePortableSessionContents(sourcePath: string): void {
	if (extname(sourcePath).toLowerCase() === ".json") {
		validatePortableSessionJsonExport(sourcePath);
		return;
	}
	validatePortableSessionJsonl(sourcePath);
}

function importSessionArtifact(
	store: MaestroAppServerExternalAgentSessionImporter | undefined,
	artifact: UnknownRecord,
	dryRun: boolean,
): MaestroAppServerExternalAgentImportedArtifact {
	if (!store?.importSessionEntries && !store?.importPortableSession) {
		return {
			kind: "session",
			status: "skipped",
			message: "Session import is not available",
		};
	}
	if (hasOwn(artifact, "entries") && store.importSessionEntries) {
		const entries = validatedSessionEntries(artifact.entries);
		if (dryRun) {
			return {
				kind: "session",
				status: "planned",
				message: "Session import planned",
			};
		}
		const result = store.importSessionEntries(entries);
		return {
			kind: "session",
			status: "imported",
			id: result.sessionId,
			path: result.sessionFile,
			message: `Imported ${result.importedCount} session(s)`,
		};
	}
	const sourcePath = stringValue(artifact.path);
	if (sourcePath && store.importPortableSession) {
		const resolvedSource = validatePortableSessionPath(sourcePath);
		validatePortableSessionContents(resolvedSource);
		if (dryRun) {
			return {
				kind: "session",
				status: "planned",
				message: "Session import planned",
			};
		}
		const result = store.importPortableSession(resolvedSource);
		return {
			kind: "session",
			status: "imported",
			id: result.sessionId,
			path: result.sessionFile,
			message: `Imported ${result.importedCount} session(s)`,
		};
	}
	throw new MaestroAppServerExternalAgentImportError(
		-32602,
		"Session artifact requires entries or path",
	);
}

function importArtifact(
	store: MaestroAppServerExternalAgentSessionImporter | undefined,
	artifact: UnknownRecord,
	projectRoot: string,
	dryRun: boolean,
): MaestroAppServerExternalAgentImportedArtifact[] {
	const kind = stringValue(artifact.kind);
	try {
		switch (kind) {
			case "session":
				return [importSessionArtifact(store, artifact, dryRun)];
			case "config":
				return [writeConfigImport(artifact, projectRoot, dryRun)];
			case "hooks":
				return [writeHooksImport(artifact, projectRoot, dryRun)];
			case "mcp":
				return writeMcpImport(artifact, projectRoot, dryRun);
			case "skill":
				return [writeSkillImport(artifact, projectRoot, dryRun)];
			default:
				throw new MaestroAppServerExternalAgentImportError(
					-32602,
					"Unsupported external agent artifact kind",
				);
		}
	} catch (error) {
		return [
			{
				kind: ["session", "config", "hooks", "mcp", "skill"].includes(
					kind ?? "",
				)
					? (kind as MaestroAppServerExternalAgentImportedArtifact["kind"])
					: "config",
				status: "skipped",
				message: artifactMessage(error),
			},
		];
	}
}

export function createMaestroAppServerExternalAgentImport(
	options: MaestroAppServerExternalAgentImportOptions = {},
): MaestroAppServerExternalAgentImport {
	return {
		async importBundle(params = {}) {
			const normalizedParams = normalizeExternalAgentImportParams(params);
			const artifacts = requireArtifacts(normalizedParams);
			const dryRun = booleanValue(normalizedParams.dryRun, true);
			const projectRoot = resolve(
				stringValue(normalizedParams.projectRoot) ??
					options.projectRoot ??
					process.cwd(),
			);
			const imported = artifacts.flatMap((artifact) =>
				importArtifact(options.store, artifact, projectRoot, dryRun),
			);
			return {
				source: importSource(normalizedParams),
				dryRun,
				imported,
				warnings: imported
					.filter((artifact) => artifact.status === "skipped")
					.map((artifact) => artifact.message ?? "Artifact skipped"),
			};
		},
	};
}
