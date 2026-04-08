import type { IncomingMessage, ServerResponse } from "node:http";
import { type Static, Type } from "@sinclair/typebox";
import {
	type WritablePackageScope,
	addConfiguredPackageSpecToConfig,
	removeConfiguredPackageSpecFromConfig,
} from "../../config/index.js";
import {
	type ConfiguredPackageReport,
	type InspectedPackage,
	collectPackageValidationIssues,
	inspectPackageSource,
	listConfiguredPackageReports,
} from "../../packages/inspection.js";
import {
	formatPackageSource,
	parsePackageSource,
} from "../../packages/sources.js";
import { ApiError, respondWithApiError, sendJson } from "../server-utils.js";
import { parseAndValidateJson } from "../validation.js";

const WritablePackageScopeSchema = Type.Union([
	Type.Literal("local"),
	Type.Literal("project"),
	Type.Literal("user"),
]);

const PackageSourceSchema = Type.Object({
	source: Type.String({ minLength: 1 }),
	scope: Type.Optional(WritablePackageScopeSchema),
});

type PackageSourceInput = Static<typeof PackageSourceSchema>;

function getWritableScope(
	scope: WritablePackageScope | undefined,
): WritablePackageScope {
	return scope ?? "local";
}

function serializeInspection(inspected: InspectedPackage) {
	return {
		sourceSpec: inspected.sourceSpec,
		resolvedSource: formatPackageSource(inspected.source),
		sourceType: inspected.source.type,
		resolvedPath: inspected.resolvedPath,
		discovered: inspected.discovered
			? {
					name: inspected.discovered.packageJson.name,
					version: inspected.discovered.packageJson.version,
					isMaestroPackage: inspected.discovered.isMaestroPackage,
					hasManifest: Boolean(inspected.discovered.packageJson.maestro),
					manifestPaths: inspected.discovered.packageJson.maestro ?? null,
					errors: inspected.discovered.errors ?? [],
				}
			: null,
		resources: inspected.resources
			? {
					extensions: inspected.resources.extensions,
					skills: inspected.resources.skills,
					prompts: inspected.resources.prompts,
					themes: inspected.resources.themes,
				}
			: null,
	};
}

function serializeConfiguredPackageReport(report: ConfiguredPackageReport) {
	return {
		scope: report.entry.scope,
		configPath: report.entry.configPath,
		sourceSpec: report.sourceSpec,
		filters: report.filters ?? null,
		inspection: report.inspected ? serializeInspection(report.inspected) : null,
		issues: report.inspected
			? collectPackageValidationIssues(report.inspected)
			: null,
		error: report.error ?? null,
	};
}

function tryResolvePackageIdentity(
	sourceSpec: string,
	cwd: string,
): string | null {
	try {
		return formatPackageSource(parsePackageSource(sourceSpec, cwd));
	} catch {
		return null;
	}
}

function findPackageFallback(
	sourceSpec: string,
	workspaceDir: string,
	reports: ConfiguredPackageReport[],
): { scope: WritablePackageScope; sourceSpec: string } | null {
	const requestedIdentity = tryResolvePackageIdentity(sourceSpec, workspaceDir);
	const matches = reports.filter((report) => {
		if (report.sourceSpec === sourceSpec) {
			return true;
		}
		if (!requestedIdentity) {
			return false;
		}
		const entryIdentity = tryResolvePackageIdentity(
			report.sourceSpec,
			report.entry.cwd,
		);
		return entryIdentity === requestedIdentity;
	});

	for (const scope of ["local", "project", "user"] as const) {
		const match = matches.find((entry) => entry.entry.scope === scope);
		if (match) {
			return { scope: match.entry.scope, sourceSpec: match.sourceSpec };
		}
	}

	return null;
}

export async function handlePackageStatus(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
): Promise<void> {
	try {
		const projectRoot = process.cwd();
		const url = new URL(req.url ?? "/api/package", "http://localhost");
		const action = url.searchParams.get("action")?.toLowerCase() ?? "list";

		if (req.method === "GET") {
			if (action !== "list" && action !== "status") {
				throw new ApiError(400, `Unknown package action: ${action}`);
			}
			const reports = await listConfiguredPackageReports(projectRoot);
			sendJson(
				res,
				200,
				{ packages: reports.map(serializeConfiguredPackageReport) },
				corsHeaders,
			);
			return;
		}

		if (req.method !== "POST") {
			throw new ApiError(405, "Method not allowed");
		}

		if (action === "inspect") {
			const input = await parseAndValidateJson<PackageSourceInput>(
				req,
				PackageSourceSchema,
			);
			const inspected = await inspectPackageSource(input.source, projectRoot);
			sendJson(
				res,
				200,
				{
					inspection: serializeInspection(inspected),
					issues: collectPackageValidationIssues(inspected),
				},
				corsHeaders,
			);
			return;
		}

		if (action === "validate") {
			const input = await parseAndValidateJson<PackageSourceInput>(
				req,
				PackageSourceSchema,
			);
			const inspected = await inspectPackageSource(input.source, projectRoot);
			sendJson(
				res,
				200,
				{
					inspection: serializeInspection(inspected),
					issues: collectPackageValidationIssues(inspected),
				},
				corsHeaders,
			);
			return;
		}

		if (action === "add") {
			const input = await parseAndValidateJson<PackageSourceInput>(
				req,
				PackageSourceSchema,
			);
			const result = addConfiguredPackageSpecToConfig({
				workspaceDir: projectRoot,
				scope: getWritableScope(input.scope),
				spec: input.source,
			});
			sendJson(
				res,
				200,
				{
					path: result.path,
					scope: result.scope,
					spec:
						typeof result.spec === "string" ? result.spec : result.spec.source,
				},
				corsHeaders,
			);
			return;
		}

		if (action === "remove") {
			const input = await parseAndValidateJson<PackageSourceInput>(
				req,
				PackageSourceSchema,
			);
			const result = removeConfiguredPackageSpecFromConfig({
				workspaceDir: projectRoot,
				scope: input.scope,
				spec: input.source,
			});
			const reports = await listConfiguredPackageReports(projectRoot);
			sendJson(
				res,
				200,
				{
					path: result.path,
					scope: result.scope,
					removedCount: result.removedCount,
					fallback: findPackageFallback(input.source, projectRoot, reports),
				},
				corsHeaders,
			);
			return;
		}

		throw new ApiError(400, `Unknown package action: ${action}`);
	} catch (error) {
		respondWithApiError(res, error, 500, corsHeaders);
	}
}
