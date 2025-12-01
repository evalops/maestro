import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	DiagConsoleLogger,
	DiagLogLevel,
	diag,
	trace,
} from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
	SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
	SEMRESATTRS_SERVICE_NAME,
	SEMRESATTRS_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

let sdkStartPromise: Promise<void> | null = null;
let sdkStarted = false;
let handlersRegistered = false;
let configuredServiceName: string | null = null;
let configuredSampler: string | null = null;
let sdkInstance: NodeSDK | null = null;

const packageVersion = (): string => {
	try {
		const __filename = fileURLToPath(import.meta.url);
		const __dirname = dirname(__filename);
		const pkg = JSON.parse(
			readFileSync(join(__dirname, "../package.json"), "utf-8"),
		);
		return typeof pkg.version === "string" ? pkg.version : "unknown";
	} catch {
		return "unknown";
	}
};

export const isOpenTelemetryEnabled = (): boolean => {
	if (process.env.COMPOSER_OTEL === "0") {
		return false;
	}

	if (process.env.COMPOSER_OTEL === "1") {
		return true;
	}

	const hasOtlpEndpoint = Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
	const traceExporter = process.env.OTEL_TRACES_EXPORTER;
	const metricsExporter = process.env.OTEL_METRICS_EXPORTER;
	const logsExporter = process.env.OTEL_LOGS_EXPORTER;
	const hasExplicitExporter =
		(traceExporter && traceExporter !== "none") ||
		(metricsExporter && metricsExporter !== "none") ||
		(logsExporter && logsExporter !== "none");

	return hasOtlpEndpoint || Boolean(hasExplicitExporter);
};

export const getTelemetryTracer = () => trace.getTracer("composer");

export interface OpenTelemetryStatus {
	enabled: boolean;
	reason: string;
	serviceName: string;
	sdkStarted: boolean;
	otlpEndpoint?: string;
	tracesExporter?: string;
	metricsExporter?: string;
	logsExporter?: string;
	autoInstrumentation: boolean;
	sampler?: string;
}

export function getOpenTelemetryStatus(): OpenTelemetryStatus {
	const enabled = isOpenTelemetryEnabled();
	const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
	const tracesExporter =
		process.env.OTEL_TRACES_EXPORTER || (otlpEndpoint ? "otlp" : "default");
	const metricsExporter =
		process.env.OTEL_METRICS_EXPORTER || (otlpEndpoint ? "otlp" : "default");
	const logsExporter =
		process.env.OTEL_LOGS_EXPORTER || (otlpEndpoint ? "otlp" : "default");
	const sampler =
		configuredSampler ||
		process.env.OTEL_TRACES_SAMPLER ||
		process.env.COMPOSER_OTEL_SAMPLER ||
		"parentbased_traceidratio";

	const reason = enabled
		? process.env.COMPOSER_OTEL === "1"
			? "COMPOSER_OTEL=1"
			: "OTEL exporter detected"
		: process.env.COMPOSER_OTEL === "0"
			? "COMPOSER_OTEL=0"
			: "no OTEL exporter configured";

	return {
		enabled,
		reason,
		serviceName:
			configuredServiceName ||
			process.env.COMPOSER_OTEL_SERVICE_NAME ||
			"composer",
		sdkStarted,
		otlpEndpoint,
		tracesExporter,
		metricsExporter,
		logsExporter,
		autoInstrumentation: enabled,
		sampler,
	};
}

export async function initOpenTelemetry(
	serviceName = "composer",
): Promise<void> {
	if (sdkStartPromise) {
		return sdkStartPromise;
	}
	if (!isOpenTelemetryEnabled()) {
		sdkStartPromise = Promise.resolve();
		return sdkStartPromise;
	}

	diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

	const resolvedServiceName =
		process.env.COMPOSER_OTEL_SERVICE_NAME || serviceName;
	configuredServiceName = resolvedServiceName;

	if (process.env.COMPOSER_OTEL_SAMPLER && !process.env.OTEL_TRACES_SAMPLER) {
		process.env.OTEL_TRACES_SAMPLER = process.env.COMPOSER_OTEL_SAMPLER;
		configuredSampler = process.env.COMPOSER_OTEL_SAMPLER;
	} else if (process.env.OTEL_TRACES_SAMPLER) {
		configuredSampler = process.env.OTEL_TRACES_SAMPLER;
	}
	const resource = resourceFromAttributes({
		[SEMRESATTRS_SERVICE_NAME]: resolvedServiceName,
		[SEMRESATTRS_SERVICE_VERSION]: packageVersion(),
		[SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV ?? "development",
	});

	const sdk = new NodeSDK({
		resource,
		instrumentations: [getNodeAutoInstrumentations()],
	});
	sdkInstance = sdk;
	sdkStartPromise = Promise.resolve().then(() => {
		try {
			sdk.start();
			sdkStarted = true;
		} catch {
			// If OTEL boot fails, continue without blocking CLI/Web usage
		}
	});

	if (!handlersRegistered) {
		handlersRegistered = true;
		const shutdown = async () => {
			try {
				if (sdkInstance) {
					await sdkInstance.shutdown();
				}
			} catch {
				// Ignore shutdown failures
			}
		};

		process.once("beforeExit", () => {
			void shutdown();
		});
		process.once("SIGINT", () => {
			void shutdown();
		});
		process.once("SIGTERM", () => {
			void shutdown();
		});
	}

	return sdkStartPromise;
}
