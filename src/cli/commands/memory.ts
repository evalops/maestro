import chalk from "chalk";
import { badge, muted, sectionHeading, separator } from "../../style/theme.js";

const REQUEST_TIMEOUT_MS = 5000;

type SharedMemoryConfig = {
	baseUrl: string;
	apiKey?: string;
};

type CapabilitiesResponse = {
	supports_sync?: boolean;
	supports_gzip?: boolean;
	max_body_bytes?: number;
	max_events_batch?: number;
	max_events?: number;
};

type ServiceMetricsResponse = {
	status?: string;
	now?: string;
	capabilities?: CapabilitiesResponse;
};

type SessionMetricsResponse = {
	meta?: {
		session_id?: string;
		last_seq?: number;
		min_seq?: number;
		updated_at?: string;
		event_count?: number;
	};
	metrics?: Record<string, unknown>;
};

type AuditResponse = {
	meta?: {
		session_id?: string;
		last_seq?: number;
		updated_at?: string;
	};
	items?: Array<Record<string, unknown>>;
};

function getConfig(): SharedMemoryConfig {
	const base = process.env.COMPOSER_SHARED_MEMORY_BASE?.trim();
	if (!base) {
		console.error(
			chalk.red(
				"COMPOSER_SHARED_MEMORY_BASE is not set. Configure shared memory to use this command.",
			),
		);
		process.exit(1);
	}
	const apiKey = process.env.COMPOSER_SHARED_MEMORY_API_KEY?.trim();
	return {
		baseUrl: base.replace(/\/+$/, ""),
		apiKey: apiKey || undefined,
	};
}

function buildHeaders(config: SharedMemoryConfig): Headers {
	const headers = new Headers();
	if (config.apiKey) {
		headers.set("Authorization", `Bearer ${config.apiKey}`);
	}
	return headers;
}

async function fetchJson(
	config: SharedMemoryConfig,
	path: string,
): Promise<unknown> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(`${config.baseUrl}${path}`, {
			headers: buildHeaders(config),
			signal: controller.signal,
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(
				`Shared memory error ${response.status}: ${text || response.statusText}`,
			);
		}
		return text ? (JSON.parse(text) as unknown) : {};
	} finally {
		clearTimeout(timeout);
	}
}

async function fetchText(
	config: SharedMemoryConfig,
	path: string,
): Promise<string> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(`${config.baseUrl}${path}`, {
			headers: buildHeaders(config),
			signal: controller.signal,
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(
				`Shared memory error ${response.status}: ${text || response.statusText}`,
			);
		}
		return text;
	} finally {
		clearTimeout(timeout);
	}
}

function printCapabilities(cap?: CapabilitiesResponse): void {
	if (!cap) {
		console.log(muted("Capabilities unavailable"));
		return;
	}
	const supportsSync = cap.supports_sync !== false;
	const supportsGzip = cap.supports_gzip !== false;
	console.log(
		`${badge("sync", supportsSync ? "on" : "off", supportsSync ? "success" : "warn")}${separator()}${badge(
			"gzip",
			supportsGzip ? "on" : "off",
			supportsGzip ? "success" : "warn",
		)}${separator()}${badge(
			"max_body",
			String(cap.max_body_bytes ?? "?"),
		)}${separator()}${badge(
			"max_batch",
			String(cap.max_events_batch ?? "?"),
		)}${separator()}${badge("max_events", String(cap.max_events ?? "?"))}`,
	);
}

async function printStatus(config: SharedMemoryConfig): Promise<void> {
	console.log(sectionHeading("Shared Memory"));
	console.log(muted(`Base: ${config.baseUrl}`));
	try {
		const metrics = (await fetchJson(
			config,
			"/metrics",
		)) as ServiceMetricsResponse;
		console.log(muted(`Status: ${metrics.status ?? "unknown"}`));
		if (metrics.now) {
			console.log(muted(`Time: ${metrics.now}`));
		}
		printCapabilities(metrics.capabilities);
	} catch (error) {
		console.error(
			chalk.red(
				`Failed to fetch shared memory status: ${error instanceof Error ? error.message : String(error)}`,
			),
		);
		process.exit(1);
	}
}

async function printSessionMetrics(
	config: SharedMemoryConfig,
	sessionId: string,
): Promise<void> {
	console.log(sectionHeading("Shared Memory Session"));
	console.log(muted(`Session: ${sessionId}`));
	const response = (await fetchJson(
		config,
		`/sessions/${encodeURIComponent(sessionId)}/metrics`,
	)) as SessionMetricsResponse;
	if (response.meta) {
		console.log(
			`${badge("last_seq", String(response.meta.last_seq ?? "?"))}${separator()}${badge(
				"min_seq",
				String(response.meta.min_seq ?? "?"),
			)}${separator()}${badge(
				"events",
				String(response.meta.event_count ?? "?"),
			)}`,
		);
		if (response.meta.updated_at) {
			console.log(muted(`Updated: ${response.meta.updated_at}`));
		}
	}
	if (response.metrics) {
		console.log();
		console.log(sectionHeading("Sync Metrics"));
		for (const [key, value] of Object.entries(response.metrics)) {
			if (value === null || value === undefined) continue;
			console.log(muted(`  ${key}: ${JSON.stringify(value)}`));
		}
	}
}

async function printAudit(
	config: SharedMemoryConfig,
	sessionId: string,
	limit?: number,
): Promise<void> {
	console.log(sectionHeading("Shared Memory Audit"));
	const response = (await fetchJson(
		config,
		`/sessions/${encodeURIComponent(sessionId)}/audit`,
	)) as AuditResponse;
	const items = response.items ?? [];
	const trimmed = limit ? items.slice(-limit) : items;
	if (!trimmed.length) {
		console.log(muted("No audit entries found."));
		return;
	}
	for (const entry of trimmed) {
		const at = entry.at ? String(entry.at) : "?";
		const mode = entry.mode ? String(entry.mode) : "?";
		const events = entry.event_count ? String(entry.event_count) : "0";
		const source = entry.source ? String(entry.source) : "?";
		console.log(
			`${chalk.cyan(at)} ${separator()}${badge("mode", mode)}${separator()}${badge(
				"events",
				events,
			)}${separator()}${badge("source", source)}`,
		);
	}
}

async function exportMetrics(
	config: SharedMemoryConfig,
	sessionId: string,
): Promise<void> {
	const text = await fetchText(
		config,
		`/sessions/${encodeURIComponent(sessionId)}/metrics.jsonl`,
	);
	process.stdout.write(text);
	if (!text.endsWith("\n")) {
		process.stdout.write("\n");
	}
}

function parseInterval(value: string | undefined): number {
	if (!value) return 2000;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return 2000;
	return parsed;
}

export async function handleMemoryCommand(
	subcommand: string | undefined,
	args: string[],
): Promise<void> {
	const config = getConfig();
	switch (subcommand) {
		case undefined:
		case "status":
			await printStatus(config);
			return;
		case "capabilities": {
			const caps = (await fetchJson(
				config,
				"/capabilities",
			)) as CapabilitiesResponse;
			console.log(sectionHeading("Shared Memory Capabilities"));
			printCapabilities(caps);
			return;
		}
		case "session": {
			const sessionId = args[0];
			if (!sessionId) {
				console.error(chalk.red("Session id required."));
				process.exit(1);
			}
			await printSessionMetrics(config, sessionId);
			return;
		}
		case "audit": {
			const sessionId = args[0];
			if (!sessionId) {
				console.error(chalk.red("Session id required."));
				process.exit(1);
			}
			const limit = args[1] ? Number.parseInt(args[1], 10) : undefined;
			await printAudit(config, sessionId, limit);
			return;
		}
		case "export": {
			const sessionId = args[0];
			if (!sessionId) {
				console.error(chalk.red("Session id required."));
				process.exit(1);
			}
			await exportMetrics(config, sessionId);
			return;
		}
		case "watch": {
			const sessionId = args[0];
			const intervalMs = parseInterval(args[1]);
			console.log(
				muted(
					`Watching ${sessionId ? `session ${sessionId}` : "service"} every ${intervalMs}ms. Ctrl+C to stop.`,
				),
			);
			while (true) {
				try {
					if (sessionId) {
						await printSessionMetrics(config, sessionId);
					} else {
						await printStatus(config);
					}
				} catch (error) {
					console.error(
						chalk.red(
							`Shared memory watch error: ${error instanceof Error ? error.message : String(error)}`,
						),
					);
				}
				await new Promise((resolve) => setTimeout(resolve, intervalMs));
			}
			return;
		}
		default:
			console.error(chalk.red(`Unknown memory subcommand: ${subcommand}`));
			console.log(chalk.dim("\nAvailable commands:"));
			console.log(chalk.dim("  composer memory [status]"));
			console.log(chalk.dim("  composer memory capabilities"));
			console.log(chalk.dim("  composer memory session <id>"));
			console.log(chalk.dim("  composer memory audit <id> [limit]"));
			console.log(chalk.dim("  composer memory export <id>"));
			console.log(chalk.dim("  composer memory watch [id] [intervalMs]"));
			process.exit(1);
	}
}
