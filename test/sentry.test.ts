import { afterEach, describe, expect, it, vi } from "vitest";
import {
	captureSentryException,
	flushSentry,
	initSentry,
	sentryConfigFromEnv,
} from "../src/sentry.js";

const sentryMock = vi.hoisted(() => ({
	flush: vi.fn(async () => true),
	init: vi.fn(),
	setTag: vi.fn(),
	captureException: vi.fn(),
}));

vi.mock("@sentry/node", () => ({
	init: sentryMock.init,
	setTag: sentryMock.setTag,
	captureException: sentryMock.captureException,
	flush: sentryMock.flush,
}));

afterEach(() => {
	vi.clearAllMocks();
});

describe("sentryConfigFromEnv", () => {
	it("is disabled when no DSN is configured", () => {
		expect(sentryConfigFromEnv()).toBeNull();
	});

	it("derives runtime config from Sentry env vars", () => {
		process.env.SENTRY_DSN = "https://public@example.ingest.sentry.io/1";
		process.env.SENTRY_ENVIRONMENT = "production";
		process.env.SENTRY_RELEASE = "maestro@sha";
		process.env.SENTRY_TRACES_SAMPLE_RATE = "0.25";
		process.env.SENTRY_PROFILES_SAMPLE_RATE = "0.1";
		process.env.SENTRY_SEND_DEFAULT_PII = "true";

		expect(sentryConfigFromEnv()).toMatchObject({
			dsn: "https://public@example.ingest.sentry.io/1",
			environment: "production",
			release: "maestro@sha",
			tracesSampleRate: 0.25,
			profilesSampleRate: 0.1,
			sendDefaultPii: true,
		});
	});

	it("falls back to safe sample rates for invalid env values", () => {
		process.env.SENTRY_DSN = "https://public@example.ingest.sentry.io/1";
		process.env.SENTRY_TRACES_SAMPLE_RATE = "2";
		process.env.SENTRY_PROFILES_SAMPLE_RATE = "nope";

		expect(sentryConfigFromEnv()).toMatchObject({
			tracesSampleRate: 0,
			profilesSampleRate: 0,
		});
	});
});

describe("initSentry", () => {
	it("does not initialize when disabled", () => {
		expect(initSentry("maestro-cli")).toBe(false);
		expect(sentryMock.init).not.toHaveBeenCalled();
	});

	it("initializes once and retags subsequent entrypoints", async () => {
		process.env.SENTRY_DSN = "https://public@example.ingest.sentry.io/1";

		expect(initSentry("maestro-cli")).toBe(true);
		expect(initSentry("maestro-web-server")).toBe(true);

		expect(sentryMock.init).toHaveBeenCalledTimes(1);
		expect(sentryMock.setTag).toHaveBeenCalledWith(
			"service.name",
			"maestro-cli",
		);
		expect(sentryMock.setTag).toHaveBeenCalledWith(
			"service.name",
			"maestro-web-server",
		);

		const error = new Error("boom");
		captureSentryException(error);
		await expect(flushSentry()).resolves.toBe(true);

		expect(sentryMock.captureException).toHaveBeenCalledWith(error);
		expect(sentryMock.flush).toHaveBeenCalledWith(2000);
	});
});
