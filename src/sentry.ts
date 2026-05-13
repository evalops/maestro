import * as Sentry from "@sentry/node";
import { getPackageVersion } from "./package-metadata.js";

interface SentryRuntimeConfig {
	dsn: string;
	environment: string;
	release: string;
	tracesSampleRate: number;
	profilesSampleRate: number;
	sendDefaultPii: boolean;
}

let initialized = false;

function firstNonBlank(...values: Array<string | undefined>): string {
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed) {
			return trimmed;
		}
	}
	return "";
}

function readSampleRate(key: string, fallback: number): number {
	const raw = process.env[key]?.trim();
	if (!raw) {
		return fallback;
	}
	const parsed = Number.parseFloat(raw);
	if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
		return fallback;
	}
	return parsed;
}

function readBooleanFlag(key: string, fallback: boolean): boolean {
	const raw = process.env[key]?.trim().toLowerCase();
	if (!raw) {
		return fallback;
	}
	return ["1", "true", "t", "yes", "y", "on"].includes(raw);
}

export function sentryConfigFromEnv(): SentryRuntimeConfig | null {
	const dsn = process.env.SENTRY_DSN?.trim();
	if (!dsn) {
		return null;
	}

	const release = firstNonBlank(
		process.env.SENTRY_RELEASE,
		process.env.MAESTRO_RELEASE,
		process.env.MAESTRO_VERSION,
		`maestro@${getPackageVersion()}`,
	);

	return {
		dsn,
		environment: firstNonBlank(
			process.env.SENTRY_ENVIRONMENT,
			process.env.MAESTRO_ENVIRONMENT,
			process.env.MAESTRO_PROFILE,
			process.env.NODE_ENV,
			"development",
		),
		release,
		tracesSampleRate: readSampleRate("SENTRY_TRACES_SAMPLE_RATE", 0),
		profilesSampleRate: readSampleRate("SENTRY_PROFILES_SAMPLE_RATE", 0),
		sendDefaultPii: readBooleanFlag("SENTRY_SEND_DEFAULT_PII", false),
	};
}

export function initSentry(serviceName: string): boolean {
	const config = sentryConfigFromEnv();
	if (!config) {
		return false;
	}

	if (!initialized) {
		Sentry.init({
			dsn: config.dsn,
			environment: config.environment,
			release: config.release,
			tracesSampleRate: config.tracesSampleRate,
			profilesSampleRate: config.profilesSampleRate,
			sendDefaultPii: config.sendDefaultPii,
			skipOpenTelemetrySetup: true,
		});
		initialized = true;
	}

	Sentry.setTag("service.name", serviceName);
	Sentry.setTag("service.namespace", "maestro");
	Sentry.setTag("runtime", "node");
	return true;
}

export function captureSentryException(error: unknown): void {
	if (!initialized) {
		return;
	}
	Sentry.captureException(
		error instanceof Error ? error : new Error(String(error)),
	);
}

export async function flushSentry(timeoutMs = 2000): Promise<boolean> {
	if (!initialized) {
		return true;
	}
	return Sentry.flush(timeoutMs);
}
