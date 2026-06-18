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
import { readPackageVersion } from "./package-version.js";
import { defaultRuntimeEnv } from "./runtime/env.js";
import { isInternalTelemetryDisabled } from "./telemetry/disablement.js";

let sdkStartPromise: Promise<void> | null = null;
let sdkStarted = false;
let handlersRegistered = false;
let configuredServiceName: string | null = null;
let configuredSampler: string | null = null;
let sdkInstance: NodeSDK | null = null;

const packageVersion = (() => {
	let cached: string | null = null;
	return (): string => {
		if (cached) {
			return cached;
		}
		cached = readPackageVersion();
		return cached;
	};
})();

export const isOpenTelemetryEnabled = (): boolean => {
	if (isInternalTelemetryDisabled()) {
		return false;
	}

	const env = defaultRuntimeEnv();
	if (env.otelEnabled === false) {
		return false;
	}
	if (env.otelEnabled === true) {
		return true;
	}

	// Standardized OTel SDK env vars — owned by the SDK, not Maestro,
	// so we read them live rather than through the substrate.
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
	const env = defaultRuntimeEnv();
	const internalTelemetryDisabled = isInternalTelemetryDisabled();
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
		env.otelSampler ||
		"parentbased_traceidratio";

	const reason = enabled
		? env.otelEnabled === true
			? `MAESTRO_OTEL=${env.otelFlag}`
			: "OTEL exporter detected"
		: internalTelemetryDisabled
			? "internal telemetry disabled"
			: env.otelEnabled === false
				? `MAESTRO_OTEL=${env.otelFlag}`
				: "no OTEL exporter configured";

	return {
		enabled,
		reason,
		serviceName: configuredServiceName || env.otelServiceName || "composer",
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

	const env = defaultRuntimeEnv();
	const resolvedServiceName = env.otelServiceName || serviceName;
	configuredServiceName = resolvedServiceName;

	// Bridge: the OTel SDK reads `OTEL_TRACES_SAMPLER` from live env at
	// startup. If only the Maestro-namespaced alias is set, copy it
	// across so the SDK actually picks it up. The substrate snapshot
	// stays frozen — this mutation is at the SDK-boundary only.
	if (env.otelSampler && !process.env.OTEL_TRACES_SAMPLER) {
		process.env.OTEL_TRACES_SAMPLER = env.otelSampler;
		configuredSampler = env.otelSampler;
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
