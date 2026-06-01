import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SCENARIO_SOURCE_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export interface ScenarioSourceExecFileOptions {
	encoding: "utf8";
	maxBuffer: number;
}

export type ScenarioSourceExecFile = (
	file: string,
	args: string[],
	options: ScenarioSourceExecFileOptions,
) => Promise<{ stdout: string; stderr: string }>;

export interface ScenarioSourceReadOptions {
	execFile?: ScenarioSourceExecFile;
	fetch?: typeof fetch;
}

function isHttpScenarioSource(source: string): boolean {
	return source.startsWith("http://") || source.startsWith("https://");
}

function isGcsScenarioSource(source: string): boolean {
	return source.startsWith("gs://");
}

export function isRemoteScenarioSource(source: string): boolean {
	return isHttpScenarioSource(source) || isGcsScenarioSource(source);
}

export function scenarioSourceLabel(source: string): string {
	if (!isRemoteScenarioSource(source)) {
		return source;
	}
	try {
		const url = new URL(source);
		return `${url.protocol}//${url.host}${url.pathname}`;
	} catch {
		return isGcsScenarioSource(source)
			? "gs://scenario-fixture"
			: "remote-scenario-fixture";
	}
}

export function scenarioSourceBaseDir(source: string): string {
	return isRemoteScenarioSource(source)
		? process.cwd()
		: dirname(resolve(source));
}

export function readScenarioJsonSourceSync(source: string): unknown {
	if (isRemoteScenarioSource(source)) {
		throw new Error(`Remote scenario source requires async loading: ${source}`);
	}
	return JSON.parse(readFileSync(resolve(source), "utf8"));
}

function defaultExecFile(
	file: string,
	args: string[],
	options: ScenarioSourceExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolvePromise, reject) => {
		execFile(file, args, options, (error, stdout, stderr) => {
			if (error) {
				Object.assign(error, { stdout, stderr });
				reject(error);
				return;
			}
			resolvePromise({ stdout, stderr });
		});
	});
}

function validateGcsScenarioSource(source: string): void {
	let parsed: URL;
	try {
		parsed = new URL(source);
	} catch (error) {
		throw new Error(`Invalid GCS scenario source: ${source}`, {
			cause: error,
		});
	}
	if (
		parsed.protocol !== "gs:" ||
		!parsed.hostname ||
		!parsed.pathname ||
		parsed.pathname === "/"
	) {
		throw new Error(
			`GCS scenario source must include a bucket and object path: ${source}`,
		);
	}
}

async function readHttpScenarioSource(
	source: string,
	fetchImpl: typeof fetch,
): Promise<string> {
	const label = scenarioSourceLabel(source);
	const response = await fetchImpl(source, {
		headers: { Accept: "application/json" },
	});
	if (!response.ok) {
		const status = [response.status, response.statusText]
			.filter(Boolean)
			.join(" ");
		throw new Error(`Failed to read scenario ${label}: HTTP ${status}`);
	}
	return response.text();
}

async function readGcsScenarioSource(
	source: string,
	execFileImpl: ScenarioSourceExecFile,
): Promise<string> {
	validateGcsScenarioSource(source);
	try {
		const { stdout } = await execFileImpl(
			"gcloud",
			["storage", "cat", source],
			{ encoding: "utf8", maxBuffer: SCENARIO_SOURCE_MAX_BUFFER_BYTES },
		);
		return stdout;
	} catch (error) {
		const maybeError = error as NodeJS.ErrnoException & { stderr?: string };
		if (maybeError.code === "ENOENT") {
			throw new Error(
				"Reading gs:// scenario fixtures requires Google Cloud SDK (`gcloud`) on PATH, or use an HTTPS signed URL.",
				{ cause: error },
			);
		}
		const stderr = maybeError.stderr?.trim();
		throw new Error(
			`Failed to read scenario ${source} with gcloud storage cat${stderr ? `: ${stderr}` : ""}`,
			{ cause: error },
		);
	}
}

export async function readScenarioTextSource(
	source: string,
	options: ScenarioSourceReadOptions = {},
): Promise<string> {
	if (isHttpScenarioSource(source)) {
		const fetchImpl = options.fetch ?? globalThis.fetch;
		if (!fetchImpl) {
			throw new Error(
				`Reading HTTP scenario fixtures requires fetch support: ${source}`,
			);
		}
		return readHttpScenarioSource(source, fetchImpl);
	}
	if (isGcsScenarioSource(source)) {
		return readGcsScenarioSource(source, options.execFile ?? defaultExecFile);
	}
	return readFileSync(resolve(source), "utf8");
}

export async function readScenarioJsonSource(
	source: string,
	options: ScenarioSourceReadOptions = {},
): Promise<unknown> {
	return JSON.parse(await readScenarioTextSource(source, options));
}
