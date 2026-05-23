import type { Tool } from "../agent/types.js";

type JsonObject = Record<string, unknown>;
type AdditionalPropertiesConstraint = boolean | JsonObject;

type CodexCompatibleTool = Pick<
	Tool,
	"name" | "description" | "parameters" | "deferApiDefinition"
> & {
	executionLocation?: "server" | "client";
};

export type CodexDynamicToolSpec = {
	namespace?: string;
	name: string;
	description: string;
	inputSchema: JsonObject;
	deferLoading?: boolean;
};

export type CodexCompatibilityDiagnostic = {
	severity: "info" | "warning" | "error";
	code: string;
	message: string;
	toolName?: string;
	codexName?: string;
};

export type CodexDynamicToolBinding = {
	codexName: string;
	originalName: string;
};

export type CodexDynamicToolCompilation = {
	specs: CodexDynamicToolSpec[];
	bindings: CodexDynamicToolBinding[];
	diagnostics: CodexCompatibilityDiagnostic[];
};

export const CODEX_DYNAMIC_TOOL_CONFORMANCE = {
	nameMaxLength: 128,
	namespaceMaxLength: 64,
	identifierPattern: /^[a-zA-Z0-9_-]+$/,
	reservedNamespaces: [
		"api_tool",
		"browser",
		"computer",
		"container",
		"file_search",
		"functions",
		"image_gen",
		"multi_tool_use",
		"python",
		"python_user_visible",
		"submodel_delegator",
		"terminal",
		"tool_search",
		"web",
	],
	reservedNames: ["mcp"],
	reservedNamePrefixes: ["mcp__"],
	unsupportedTopLevelSchemaKeywords: ["anyOf", "oneOf", "allOf", "enum", "not"],
	dynamicToolCallMethod: "item/tool/call",
} as const;

export const CODEX_FILE_MUTATION_TOOL_PROFILE = [
	"apply_patch",
	"edit",
	"write",
] as const;

export const CODEX_READ_ONLY_TOOL_PROFILE = [
	"read",
	"list",
	"find",
	"search",
	"diff",
	"status",
] as const;

export const CODEX_DEFAULT_TOOL_PROFILE = [
	"read",
	"list",
	"find",
	"search",
	"diff",
	"bash",
	"apply_patch",
	"edit",
	"write",
	"todo",
	"status",
	"gh_pr",
] as const;

export const CODEX_EXTENDED_TOOL_PROFILE = [
	"read",
	"list",
	"find",
	"search",
	"parallel_ripgrep",
	"diff",
	"bash",
	"background_tasks",
	"apply_patch",
	"edit",
	"write",
	"todo",
	"status",
	"gh_pr",
	"gh_issue",
	"gh_repo",
] as const;

export const CODEX_TOOL_PROFILES = {
	lean: CODEX_DEFAULT_TOOL_PROFILE,
	default: CODEX_DEFAULT_TOOL_PROFILE,
	"read-only": CODEX_READ_ONLY_TOOL_PROFILE,
	readonly: CODEX_READ_ONLY_TOOL_PROFILE,
	extended: CODEX_EXTENDED_TOOL_PROFILE,
} as const;

export type CodexToolProfileName = keyof typeof CODEX_TOOL_PROFILES;

const CODEX_DYNAMIC_TOOL_COMPOSITION_SCHEMA_KEYS = [
	"anyOf",
	"oneOf",
	"allOf",
] as const;

const UNSUPPORTED_CODEX_DYNAMIC_TOOL_TOP_LEVEL_SCHEMA_KEYS = new Set<string>(
	CODEX_DYNAMIC_TOOL_CONFORMANCE.unsupportedTopLevelSchemaKeywords,
);

export function isCodexAppServerApi(api: unknown): boolean {
	return api === "openai-codex-app-server";
}

export function selectCodexDefaultTools<TTool extends { name: string }>(
	tools: readonly TTool[],
): TTool[] {
	return selectCodexToolProfile(tools, "lean");
}

export function selectCodexToolProfile<TTool extends { name: string }>(
	tools: readonly TTool[],
	profileName: CodexToolProfileName,
): TTool[] {
	const profile = CODEX_TOOL_PROFILES[profileName];
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	return profile
		.map((name) => byName.get(name))
		.filter((tool): tool is TTool => Boolean(tool));
}

export function resolveCodexToolProfileName(
	value: string | undefined,
): CodexToolProfileName {
	if (!value || value.trim().length === 0) {
		return "lean";
	}
	const normalized = value.trim().toLowerCase().replace(/_/g, "-");
	if (isCodexToolProfileName(normalized)) {
		return normalized;
	}
	throw new Error(
		`Unknown Codex tool profile "${value}". Available profiles: ${getCodexToolProfileNames().join(", ")}`,
	);
}

export function getCodexToolProfileNames(): CodexToolProfileName[] {
	return Object.keys(CODEX_TOOL_PROFILES) as CodexToolProfileName[];
}

function isCodexToolProfileName(value: string): value is CodexToolProfileName {
	return Object.hasOwn(CODEX_TOOL_PROFILES, value);
}

export function compileCodexDynamicToolSpecs(
	tools: readonly CodexCompatibleTool[],
): CodexDynamicToolCompilation {
	const specs: CodexDynamicToolSpec[] = [];
	const bindings: CodexDynamicToolBinding[] = [];
	const diagnostics: CodexCompatibilityDiagnostic[] = [];
	const seenOriginalNames = new Set<string>();
	const seenCodexNames = new Set<string>();

	for (const tool of tools) {
		if (tool.deferApiDefinition || tool.executionLocation === "client") {
			continue;
		}
		if (seenOriginalNames.has(tool.name)) {
			continue;
		}
		seenOriginalNames.add(tool.name);

		const codexName = toUniqueCodexDynamicToolName(tool.name, seenCodexNames);
		if (codexName !== tool.name) {
			diagnostics.push({
				severity: "warning",
				code: "renamed_tool",
				message: `Tool "${tool.name}" is exposed to Codex as "${codexName}" to match app-server dynamic tool identifier rules.`,
				toolName: tool.name,
				codexName,
			});
		}

		seenCodexNames.add(codexName);
		specs.push({
			name: codexName,
			description: tool.description,
			inputSchema: normalizeCodexDynamicToolInputSchema(tool.parameters),
		});
		bindings.push({ codexName, originalName: tool.name });
	}

	return { specs, bindings, diagnostics };
}

export function createCodexDynamicToolNameMap(
	bindings: readonly CodexDynamicToolBinding[],
): Map<string, string> {
	return new Map(
		bindings.map((binding) => [binding.codexName, binding.originalName]),
	);
}

export function normalizeCodexDynamicToolInputSchema(
	schema: unknown,
): JsonObject {
	if (!isRecord(schema)) {
		return emptyCodexDynamicToolInputSchema();
	}

	const flattened = flattenTopLevelCompositionSchema(schema);
	if (flattened) {
		return flattened;
	}

	const normalized: JsonObject = {};
	for (const [key, value] of Object.entries(schema)) {
		if (UNSUPPORTED_CODEX_DYNAMIC_TOOL_TOP_LEVEL_SCHEMA_KEYS.has(key)) {
			continue;
		}
		normalized[key] = value;
	}
	normalized.type = "object";
	if (!isRecord(normalized.properties)) {
		normalized.properties = {};
	}
	if (!("additionalProperties" in normalized)) {
		normalized.additionalProperties = false;
	}
	return normalized;
}

function toUniqueCodexDynamicToolName(
	toolName: string,
	seenCodexNames: ReadonlySet<string>,
): string {
	const baseName = toCodexDynamicToolName(toolName);
	if (!seenCodexNames.has(baseName)) {
		return baseName;
	}
	for (let index = 2; ; index += 1) {
		const suffix = `_${index}`;
		const candidate = `${truncateIdentifier(
			baseName,
			CODEX_DYNAMIC_TOOL_CONFORMANCE.nameMaxLength - suffix.length,
		)}${suffix}`;
		if (!seenCodexNames.has(candidate)) {
			return candidate;
		}
	}
}

function toCodexDynamicToolName(toolName: string): string {
	const trimmed = toolName.trim();
	let codexName = trimmed.replace(/[^a-zA-Z0-9_-]/g, "_");
	if (codexName.length === 0) {
		codexName = "maestro_tool";
	}
	if (isReservedCodexDynamicToolIdentifier(codexName)) {
		codexName = `maestro_${codexName}`;
	}
	return truncateIdentifier(
		codexName,
		CODEX_DYNAMIC_TOOL_CONFORMANCE.nameMaxLength,
	);
}

function isReservedCodexDynamicToolIdentifier(value: string): boolean {
	return (
		CODEX_DYNAMIC_TOOL_CONFORMANCE.reservedNames.some(
			(reservedName) => value === reservedName,
		) ||
		CODEX_DYNAMIC_TOOL_CONFORMANCE.reservedNamePrefixes.some((prefix) =>
			value.startsWith(prefix),
		)
	);
}

function truncateIdentifier(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value;
	}
	return value.slice(0, Math.max(1, maxLength));
}

function emptyCodexDynamicToolInputSchema(): JsonObject {
	return {
		type: "object",
		properties: {},
		additionalProperties: false,
	};
}

function flattenTopLevelCompositionSchema(
	schema: JsonObject,
): JsonObject | null {
	for (const key of CODEX_DYNAMIC_TOOL_COMPOSITION_SCHEMA_KEYS) {
		const branches = schema[key];
		if (!Array.isArray(branches)) {
			continue;
		}
		if (branches.length === 0 || !branches.every(isRecord)) {
			return emptyCodexDynamicToolInputSchema();
		}
		return flattenObjectSchemaBranches(schema, key, branches);
	}
	return null;
}

function flattenObjectSchemaBranches(
	schema: JsonObject,
	compositionKey: (typeof CODEX_DYNAMIC_TOOL_COMPOSITION_SCHEMA_KEYS)[number],
	branches: JsonObject[],
): JsonObject {
	const propertySchemas = new Map<string, unknown[]>();
	const topLevelProperties = schema.properties;
	if (isRecord(topLevelProperties)) {
		for (const [name, propertySchema] of Object.entries(topLevelProperties)) {
			addPropertySchema(propertySchemas, name, propertySchema);
		}
	}

	const branchRequiredSets: Array<Set<string>> = [];
	for (const branch of branches) {
		const branchProperties = branch.properties;
		if (isRecord(branchProperties)) {
			for (const [name, propertySchema] of Object.entries(branchProperties)) {
				addPropertySchema(propertySchemas, name, propertySchema);
			}
		}
		branchRequiredSets.push(new Set(readStringArray(branch.required)));
	}

	const properties: JsonObject = {};
	for (const [name, schemas] of propertySchemas.entries()) {
		properties[name] = mergePropertySchemas(schemas);
	}

	const required = computeFlattenedRequired(
		schema,
		compositionKey,
		branchRequiredSets,
	).filter((name) => name in properties);
	const flattened: JsonObject = {
		type: "object",
		properties,
		additionalProperties: computeFlattenedAdditionalProperties(
			schema,
			compositionKey,
			branches,
		),
	};
	if (typeof schema.description === "string") {
		flattened.description = schema.description;
	}
	if (required.length > 0) {
		flattened.required = required;
	}
	return flattened;
}

function addPropertySchema(
	propertySchemas: Map<string, unknown[]>,
	name: string,
	propertySchema: unknown,
): void {
	const schemas = propertySchemas.get(name);
	if (schemas) {
		schemas.push(propertySchema);
		return;
	}
	propertySchemas.set(name, [propertySchema]);
}

function computeFlattenedRequired(
	schema: JsonObject,
	compositionKey: (typeof CODEX_DYNAMIC_TOOL_COMPOSITION_SCHEMA_KEYS)[number],
	branchRequiredSets: Array<Set<string>>,
): string[] {
	const topLevelRequired = readStringArray(schema.required);
	if (branchRequiredSets.length === 0) {
		return topLevelRequired;
	}
	if (compositionKey === "allOf") {
		return uniqueStrings([
			...topLevelRequired,
			...branchRequiredSets.flatMap((set) => [...set]),
		]);
	}
	const firstBranchRequired = branchRequiredSets[0] ?? new Set<string>();
	const requiredByEveryBranch = [...firstBranchRequired].filter((name) =>
		branchRequiredSets.every((set) => set.has(name)),
	);
	return uniqueStrings([...topLevelRequired, ...requiredByEveryBranch]);
}

function mergePropertySchemas(schemas: unknown[]): unknown {
	const uniqueSchemas = uniqueJsonItems(schemas);
	if (uniqueSchemas.length <= 1) {
		return uniqueSchemas[0] ?? {};
	}

	const constValues = uniqueSchemas.map(readConstValue);
	if (constValues.every((entry) => entry.found)) {
		const schemaTypes = uniqueSchemas.map(readSchemaType);
		const commonType = schemaTypes.every((type) => type === schemaTypes[0])
			? schemaTypes[0]
			: undefined;
		return {
			...(commonType ? { type: commonType } : {}),
			enum: uniqueJsonItems(constValues.map((entry) => entry.value)),
		};
	}

	return { anyOf: uniqueSchemas };
}

function computeFlattenedAdditionalProperties(
	schema: JsonObject,
	compositionKey: (typeof CODEX_DYNAMIC_TOOL_COMPOSITION_SCHEMA_KEYS)[number],
	branches: JsonObject[],
): AdditionalPropertiesConstraint {
	const topLevelConstraint = readAdditionalPropertiesConstraint(
		schema.additionalProperties,
	);
	if (topLevelConstraint === false) {
		return false;
	}
	const branchConstraint =
		compositionKey === "allOf"
			? intersectAdditionalPropertiesConstraints(
					branches.map((branch) =>
						readAdditionalPropertiesConstraint(branch.additionalProperties),
					),
				)
			: unionAdditionalPropertiesConstraints(
					branches.map((branch) =>
						readAdditionalPropertiesConstraint(branch.additionalProperties),
					),
				);
	return intersectAdditionalPropertiesConstraints([
		topLevelConstraint,
		branchConstraint,
	]);
}

function readAdditionalPropertiesConstraint(
	value: unknown,
): AdditionalPropertiesConstraint {
	if (value === false) {
		return false;
	}
	if (isRecord(value)) {
		return value;
	}
	return true;
}

function unionAdditionalPropertiesConstraints(
	constraints: AdditionalPropertiesConstraint[],
): AdditionalPropertiesConstraint {
	if (constraints.some((constraint) => constraint === false)) {
		return false;
	}
	if (constraints.some((constraint) => constraint === true)) {
		return true;
	}
	const schemas = constraints.filter(isRecord);
	if (schemas.length === 0) {
		return false;
	}
	return combineAdditionalPropertiesSchemas("anyOf", schemas);
}

function intersectAdditionalPropertiesConstraints(
	constraints: AdditionalPropertiesConstraint[],
): AdditionalPropertiesConstraint {
	if (constraints.some((constraint) => constraint === false)) {
		return false;
	}
	const schemas = constraints.filter(isRecord);
	if (schemas.length === 0) {
		return true;
	}
	return combineAdditionalPropertiesSchemas("allOf", schemas);
}

function combineAdditionalPropertiesSchemas(
	compositionKey: "allOf" | "anyOf",
	schemas: JsonObject[],
): JsonObject {
	const uniqueSchemas = uniqueJsonItems(schemas).filter(isRecord);
	if (uniqueSchemas.length <= 1) {
		return uniqueSchemas[0] ?? {};
	}
	return { [compositionKey]: uniqueSchemas };
}

function readStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values));
}

function uniqueJsonItems(values: unknown[]): unknown[] {
	const seen = new Set<string>();
	const unique: unknown[] = [];
	for (const value of values) {
		const key = schemaJsonKey(value);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		unique.push(value);
	}
	return unique;
}

function schemaJsonKey(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function readConstValue(schema: unknown): { found: boolean; value?: unknown } {
	if (!isRecord(schema) || !("const" in schema)) {
		return { found: false };
	}
	return { found: true, value: schema.const };
}

function readSchemaType(schema: unknown): string | undefined {
	return isRecord(schema) && typeof schema.type === "string"
		? schema.type
		: undefined;
}

function isRecord(value: unknown): value is JsonObject {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
