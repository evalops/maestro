import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	PLATFORM_CONNECT_METHODS,
	PLATFORM_CONNECT_SERVICES,
	PLATFORM_HTTP_ROUTES,
	platformConnectMethodPath,
} from "../src/platform/core-services.js";

const EXPECTED_PACKAGE_NAME = "@evalops/sdk-ts";

const serviceModules = {
	approvals: {
		specifier: "approvals/v1/approvals_pb",
		exportName: "ApprovalService",
	},
	connectors: {
		specifier: "connectors/v1/connectors_pb",
		exportName: "ConnectorService",
	},
	governance: {
		specifier: "governance/v1/governance_pb",
		exportName: "GovernanceService",
	},
	llmGateway: {
		specifier: "llmgateway/v1/gateway_pb",
		exportName: "GatewayService",
	},
	meter: {
		specifier: "meter/v1/meter_pb",
		exportName: "MeterService",
	},
	prompts: {
		specifier: "prompts/v1/prompts_pb",
		exportName: "PromptService",
	},
} as const;

type PlatformServiceKey = keyof typeof serviceModules;
type SdkService = {
	typeName: string;
	methods?: Array<{ name: string }>;
};

function npmCommand(): string {
	return process.platform === "win32" ? "npm.cmd" : "npm";
}

function nodeCommand(): string {
	return process.execPath;
}

function resolvePlatformRepo(): string {
	const configured =
		process.env.MAESTRO_PLATFORM_REPO?.trim() ||
		process.env.PLATFORM_REPO?.trim();
	if (configured) {
		return resolve(configured);
	}

	return resolve(process.cwd(), "..", "platform");
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

function packPlatformSdk(sdkDir: string, tempDir: string): string {
	execFileSync(npmCommand(), ["ci"], {
		cwd: sdkDir,
		stdio: "inherit",
	});
	const raw = execFileSync(
		npmCommand(),
		["pack", "--json", "--pack-destination", tempDir],
		{
			cwd: sdkDir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "inherit"],
		},
	);
	const packed = JSON.parse(raw) as Array<{ filename?: string }>;
	const filename = packed[0]?.filename;
	if (!filename) {
		throw new Error("npm pack did not return a tarball filename");
	}
	return join(tempDir, filename);
}

function installPackedSdk(tempDir: string, tarball: string): {
	importPackageModule: (specifier: string) => Promise<Record<string, unknown>>;
} {
	const projectDir = join(tempDir, "maestro-platform-sdk-smoke");
	mkdirSync(projectDir);
	writeFileSync(
		join(projectDir, "package.json"),
		JSON.stringify(
			{ name: "maestro-platform-sdk-smoke", private: true, type: "module" },
			null,
			2,
		),
	);
	execFileSync(npmCommand(), ["install", tarball], {
		cwd: projectDir,
		stdio: "inherit",
	});
	const packageRoot = join(
		projectDir,
		"node_modules",
		...EXPECTED_PACKAGE_NAME.split("/"),
	);
	const packageJson = readJson(join(packageRoot, "package.json")) as {
		exports?: Record<string, string | { import?: string }>;
	};
	return {
		importPackageModule: async (specifier) => {
			const entry = packageJson.exports?.[`./${specifier}`];
			const importPath = typeof entry === "string" ? entry : entry?.import;
			if (!importPath) {
				throw new Error(
					`${EXPECTED_PACKAGE_NAME} does not export import target ./${specifier}`,
				);
			}
			const resolved = join(packageRoot, importPath);
			return import(pathToFileURL(resolved).href) as Promise<
				Record<string, unknown>
			>;
		},
	};
}

async function loadService(
	importPackageModule: (specifier: string) => Promise<Record<string, unknown>>,
	serviceKey: PlatformServiceKey,
): Promise<SdkService> {
	const moduleInfo = serviceModules[serviceKey];
	const imported = await importPackageModule(moduleInfo.specifier);
	const service = imported[moduleInfo.exportName] as SdkService | undefined;
	if (!service) {
		throw new Error(
			`${moduleInfo.specifier} is missing ${moduleInfo.exportName}`,
		);
	}
	return service;
}

async function assertConnectContracts(
	importPackageModule: (specifier: string) => Promise<Record<string, unknown>>,
): Promise<void> {
	const services = PLATFORM_CONNECT_SERVICES as Record<
		PlatformServiceKey,
		string
	>;
	const serviceDescriptors = new Map<PlatformServiceKey, SdkService>();

	for (const serviceKey of Object.keys(serviceModules) as PlatformServiceKey[]) {
		const service = await loadService(importPackageModule, serviceKey);
		serviceDescriptors.set(serviceKey, service);
		if (services[serviceKey] !== service.typeName) {
			throw new Error(
				`${serviceKey} service drifted: Maestro uses ${services[serviceKey]}, SDK exposes ${service.typeName}`,
			);
		}
	}

	const methodGroups = PLATFORM_CONNECT_METHODS as Record<
		PlatformServiceKey,
		Record<string, { service: string; method: string }>
	>;
	for (const [serviceKey, methods] of Object.entries(methodGroups) as Array<
		[PlatformServiceKey, Record<string, { service: string; method: string }>]
	>) {
		const service = serviceDescriptors.get(serviceKey);
		if (!service) {
			throw new Error(`No SDK descriptor mapped for ${serviceKey}`);
		}
		const sdkMethodNames = new Set(
			(service.methods || []).map((method) => method.name),
		);
		for (const [localName, descriptor] of Object.entries(methods)) {
			if (!sdkMethodNames.has(descriptor.method)) {
				throw new Error(
					`${serviceKey}.${localName} drifted: SDK does not expose ${descriptor.method}`,
				);
			}
			const path = platformConnectMethodPath(descriptor);
			const expectedPath = `/${service.typeName}/${descriptor.method}`;
			if (path !== expectedPath) {
				throw new Error(
					`${serviceKey}.${localName} path drifted: got ${path}, want ${expectedPath}`,
				);
			}
		}
	}
}

async function assertMemoryContract(
	importPackageModule: (specifier: string) => Promise<Record<string, unknown>>,
): Promise<void> {
	const imported = await importPackageModule("memory/v1/memory_pb");
	const service = imported.MemoryService as SdkService | undefined;
	if (!service) {
		throw new Error("memory/v1/memory_pb is missing MemoryService");
	}
	if (service.typeName !== "memory.v1.MemoryService") {
		throw new Error(`memory service drifted: SDK exposes ${service.typeName}`);
	}
	const methodNames = new Set(
		(service.methods || []).map((method) => method.name),
	);
	if (!methodNames.has("Recall")) {
		throw new Error("memory service drifted: SDK does not expose Recall");
	}
	if (PLATFORM_HTTP_ROUTES.memory.recall !== "/v1/memories/recall") {
		throw new Error(
			`memory HTTP route drifted: ${PLATFORM_HTTP_ROUTES.memory.recall}`,
		);
	}
}

async function assertIdentityContract(
	importPackageModule: (specifier: string) => Promise<Record<string, unknown>>,
): Promise<void> {
	const imported = await importPackageModule("identity/v1/tokens_pb");
	const service = imported.TokenService as SdkService | undefined;
	if (!service) {
		throw new Error("identity/v1/tokens_pb is missing TokenService");
	}
	if (service.typeName !== "identity.v1.TokenService") {
		throw new Error(
			`identity token service drifted: SDK exposes ${service.typeName}`,
		);
	}
	const methodNames = new Set(
		(service.methods || []).map((method) => method.name),
	);
	for (const method of [
		"Introspect",
		"IssueServiceToken",
		"IssueAgentToken",
		"IssueDelegationToken",
	]) {
		if (!methodNames.has(method)) {
			throw new Error(
				`identity token service drifted: SDK does not expose ${method}`,
			);
		}
	}
	if (
		PLATFORM_HTTP_ROUTES.identity.delegationTokens !== "/v1/delegation-tokens"
	) {
		throw new Error(
			`identity delegation route drifted: ${PLATFORM_HTTP_ROUTES.identity.delegationTokens}`,
		);
	}
}

async function main(): Promise<void> {
	const platformRepo = resolvePlatformRepo();
	const sdkDir = join(platformRepo, "gen", "ts");
	const packageJsonPath = join(sdkDir, "package.json");
	const packageJson = readJson(packageJsonPath) as { name?: string };
	if (packageJson.name !== EXPECTED_PACKAGE_NAME) {
		throw new Error(
			`Expected ${packageJsonPath} to define ${EXPECTED_PACKAGE_NAME}, got ${packageJson.name}`,
		);
	}

	const tempDir = mkdtempSync(join(tmpdir(), "maestro-platform-sdk-contract-"));
	try {
		const tarball = packPlatformSdk(sdkDir, tempDir);
		execFileSync(
			nodeCommand(),
			[
				join(sdkDir, "scripts", "smoke-core-service-package.mjs"),
				"--package-spec",
				tarball,
				"--package-name",
				EXPECTED_PACKAGE_NAME,
			],
			{ stdio: "inherit" },
		);

		const { importPackageModule } = installPackedSdk(tempDir, tarball);
		await assertConnectContracts(importPackageModule);
		await assertMemoryContract(importPackageModule);
		await assertIdentityContract(importPackageModule);
		console.log(
			`Validated Maestro Platform SDK contract against ${platformRepo}`,
		);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
