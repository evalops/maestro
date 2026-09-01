#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectCliEntrypoint } from "./direct-cli-entrypoint.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const maestroRoot = resolve(scriptDir, "..");
const publicOrbFixtureRoot = resolve(
	maestroRoot,
	"test/fixtures/hosted-orb-public",
);

export const CONTRACT_PATH = resolve(
	maestroRoot,
	"docs/protocols/hosted-orb-delegation-acceptance-v1.json",
);

export const REQUIRED_CASE_IDS = Object.freeze([
	"hosted_authentication",
	"start_wait_message",
	"disconnect_reconnect",
	"steering",
	"approval",
	"cancellation",
	"idempotent_retry",
	"terminal_result",
	"tenant_isolation",
	"central_mcp_allowlist_auth",
	"central_mcp_tool_call_evidence",
	"central_mcp_restart_reconnect",
	"central_mcp_revoked_credential",
	"hosted_profile_discovery",
	"atomic_launch_receipt",
	"atomic_launch_allowed_override",
	"atomic_launch_reconnect_cancel",
	"atomic_launch_rejected_profile",
]);

function asObject(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value;
}

function requiredString(value, label) {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value;
}

function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseJsonFile(path, label) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`unable to read ${label}`, { cause: error });
	}
}

function hasOpenApiRoute(openapi, method, path) {
	return Boolean(openapi.paths?.[path]?.[method.toLowerCase()]);
}

function assertNoCredentialLiteral(contract) {
	const serialized = JSON.stringify(contract);
	for (const pattern of [
		/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
		/\bsk-[A-Za-z0-9]{8,}/,
		/\bgh[pousr]_[A-Za-z0-9_]{12,}/,
		/\bxox[baprs]-[A-Za-z0-9-]{12,}/,
		/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./,
	]) {
		if (pattern.test(serialized)) {
			throw new Error("acceptance fixture contains credential-shaped material");
		}
	}
}

function responseStatus(value) {
	const status = value?.status ?? value?.statusCode ?? value?.response?.status;
	return Number.isInteger(Number(status)) ? Number(status) : undefined;
}

function responseState(value) {
	return String(
		value?.state
			?? value?.lifecycle_state
			?? value?.lifecycle_phase
			?? value?.task?.state
			?? value?.task?.lifecycle_state
			?? value?.task?.lifecycle_phase
			?? value?.launch?.state
			?? "",
	).toLowerCase();
}

function matchesRecordedOutcome(response, outcome) {
	const status = responseStatus(response);
	const state = responseState(response);
	if (outcome === "rejected" || outcome === "conflict") {
		return response?.accepted === false || (status !== undefined && status >= 400);
	}
	if (outcome === "accepted") {
		return response?.accepted !== false && (status === undefined || status < 400);
	}
	if (outcome === "same_receipt") return response?.replayed === true || state === "replaying";
	if (outcome === "pending") return Array.isArray(response?.pending);
	if (outcome === "succeeded") return response?.outcome?.status === "succeeded";
	if (outcome === "completed") return response?.terminal === true || state === "completed";
	if (outcome === "filtered") return state === "filtered" && Array.isArray(response?.tools);
	if (outcome === "recorded") return response?.recorded === true;
	if (outcome === "durable") {
		return typeof response?.receipt_id === "string"
			&& response.receipt_durable === true
			&& response.terminal === false;
	}
	if (outcome === "none") {
		return response?.provisioned === false && Number(response?.side_effects) === 0;
	}
	return state === outcome;
}

export async function loadContract(path = CONTRACT_PATH) {
	return JSON.parse(await readFile(path, "utf8"));
}

export function validateContract(
	contract,
	{ root = publicOrbFixtureRoot } = {},
) {
	asObject(contract, "contract");
	if (contract.schema !== "evalops.maestro.hosted-orb-delegation.acceptance.v1") {
		throw new Error("unexpected hosted delegation contract schema");
	}
	if (contract.version !== 1 || contract.hosted_only !== true) {
		throw new Error("hosted delegation contract must be hosted-only v1");
	}
	if (contract.transport !== "mcp-streamable-http") {
		throw new Error("hosted delegation contract must use Streamable HTTP MCP");
	}
	if (Object.hasOwn(contract, "contract_sources") || Object.hasOwn(contract, "live_gate")) {
		throw new Error("public contracts must not publish internal source or live-gate inventory");
	}
	if (Object.hasOwn(contract.atomic_launch ?? {}, "current_origin_status")) {
		throw new Error("public contracts must not publish internal rollout status");
	}
	if (!Array.isArray(contract.cases)) throw new Error("contract cases must be an array");
	if (JSON.stringify(contract.cases.map((entry) => entry.id)) !== JSON.stringify(REQUIRED_CASE_IDS)) {
		throw new Error("hosted delegation cases are incomplete or out of order");
	}

	const atomicLaunch = asObject(contract.atomic_launch, "atomic_launch");
	if (atomicLaunch.primitive !== "computer_launch") {
		throw new Error("atomic launch must use the hosted launch primitive");
	}
	if (atomicLaunch.compatibility_alias !== "orb_launch_hosted_task") {
		throw new Error("atomic launch must retain the legacy compatibility alias");
	}
	if (JSON.stringify(atomicLaunch.required_launch_arguments) !== JSON.stringify([
		"project",
		"repository_url",
		"prompt",
		"idempotency_key",
	])) {
		throw new Error("atomic launch required arguments drifted");
	}
	if (JSON.stringify(atomicLaunch.forbidden_client_arguments) !== JSON.stringify([
		"provider",
		"machine",
		"provisioner",
	])) {
		throw new Error("atomic launch must not let the client choose placement");
	}
	if (atomicLaunch.client_flow !== "single_command") {
		throw new Error("atomic launch must remain a single control-plane command");
	}
	if (atomicLaunch.receipt_before_completion !== true || atomicLaunch.rejection_must_be_side_effect_free !== true) {
		throw new Error("atomic launch receipt and rejection guarantees drifted");
	}

	const tools = asObject(contract.tools, "tools");
	const openApiPath = resolve(root, "products/orb/api/openapi.json");
	const mcpDocPath = resolve(root, "products/orb/docs/mcp.md");
	if (!existsSync(openApiPath) || !existsSync(mcpDocPath)) {
		throw new Error("public Orb contract fixtures are missing");
	}
	const openapi = parseJsonFile(openApiPath, "public Orb OpenAPI fixture");
	const mcpDoc = readFileSync(mcpDocPath, "utf8");
	for (const [name, value] of Object.entries(tools)) {
		const spec = asObject(value, `tools.${name}`);
		const method = requiredString(spec.method, `tools.${name}.method`);
		const path = requiredString(spec.path, `tools.${name}.path`);
		if (!hasOpenApiRoute(openapi, method, path)) {
			throw new Error(`${name} route ${method} ${path} is absent from public Orb OpenAPI`);
		}
		for (const additionalPath of spec.additional_paths ?? []) {
			if (!hasOpenApiRoute(openapi, "GET", additionalPath)) {
				throw new Error(`${name} additional route GET ${additionalPath} is absent from public Orb OpenAPI`);
			}
		}
		for (const scope of [spec.scope, ...(spec.additional_scopes ?? [])]) {
			requiredString(scope, `tools.${name}.scope`);
			const row = new RegExp(
				`\\|\\s*\`${escapeRegExp(name)}\`\\s*\\|[^|]*\`${escapeRegExp(scope)}\`[^|]*\\|`,
			);
			if (!row.test(mcpDoc)) {
				throw new Error(`${name} scope ${scope} drifted from public Orb MCP docs`);
			}
		}
	}

	if (!Array.isArray(contract.recorded_exchanges)) {
		throw new Error("recorded_exchanges must be an array");
	}
	const recordedByKey = new Map();
	for (const value of contract.recorded_exchanges) {
		const exchange = asObject(value, "recorded exchange");
		const key = `${requiredString(exchange.case_id, "recorded case_id")}\u0000${requiredString(exchange.name, "recorded name")}`;
		if (recordedByKey.has(key)) throw new Error(`duplicate recorded exchange ${key}`);
		recordedByKey.set(key, exchange);
	}

	let operationCount = 0;
	for (const entry of contract.cases) {
		if (!Array.isArray(entry.operations) || entry.operations.length === 0) {
			throw new Error(`${entry.id} must declare operations`);
		}
		for (const operation of entry.operations) {
			operationCount += 1;
			const key = `${entry.id}\u0000${requiredString(operation.name, `${entry.id} operation.name`)}`;
			const exchange = recordedByKey.get(key);
			if (!exchange) throw new Error(`missing recorded exchange ${entry.id}/${operation.name}`);
			if (operation.tool && exchange.request?.tool !== operation.tool) {
				throw new Error(`${entry.id}/${operation.name} recorded tool drifted`);
			}
			if (operation.tool && !tools[operation.tool]) {
				throw new Error(`${entry.id}/${operation.name} references unknown tool ${operation.tool}`);
			}
			if (operation.tenant && exchange.tenant !== operation.tenant) {
				throw new Error(`${entry.id}/${operation.name} recorded tenant drifted`);
			}
			if (!matchesRecordedOutcome(exchange.response, operation.outcome)) {
				throw new Error(`recorded acceptance failed for ${entry.id}/${operation.name}`);
			}
			if (operation.operation === "atomic_launch") {
				for (const argument of atomicLaunch.required_launch_arguments) {
					requiredString(exchange.request?.[argument], `${entry.id}/${operation.name}.${argument}`);
				}
				for (const argument of atomicLaunch.forbidden_client_arguments) {
					if (Object.hasOwn(exchange.request ?? {}, argument)) {
						throw new Error(`${entry.id}/${operation.name} chooses ${argument}`);
					}
				}
				if (["accepted", "same_receipt"].includes(operation.outcome)) {
					requiredString(exchange.response?.thread_id, `${entry.id}/${operation.name}.thread_id`);
					requiredString(
						exchange.response?.receipt_id
							?? exchange.response?.launch_receipt_id
							?? exchange.response?.launch?.id,
						`${entry.id}/${operation.name}.receipt_id`,
					);
					if (typeof exchange.response?.replayed !== "boolean") {
						throw new Error(`${entry.id}/${operation.name} omitted its replay marker`);
					}
				}
			}
		}
	}
	if (recordedByKey.size !== operationCount) {
		throw new Error("recorded exchanges include operations outside the public contract");
	}
	assertNoCredentialLiteral(contract);
	return contract;
}

export async function runRecordedAcceptance(contract) {
	validateContract(contract);
	return {
		schema: contract.schema,
		mode: "recorded",
		status: "passed",
		hosted_only: true,
		local_control_plane: false,
		cases: contract.cases.map((entry) => ({
			id: entry.id,
			status: "passed",
			operations: entry.operations.length,
		})),
		operations: contract.cases.reduce(
			(count, entry) => count + entry.operations.length,
			0,
		),
		network_requests: 0,
	};
}

export async function main(argv = process.argv.slice(2)) {
	if (argv.length > 0) {
		throw new Error("the public acceptance check supports recorded protocol validation only");
	}
	const result = await runRecordedAcceptance(await loadContract());
	console.log(JSON.stringify(result, null, 2));
	return 0;
}

if (isDirectCliEntrypoint(import.meta.url)) {
	main().then((status) => {
		process.exitCode = status;
	}).catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
