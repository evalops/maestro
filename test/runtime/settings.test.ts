import { afterEach, describe, expect, it } from "vitest";
import {
	createRuntimeEnv,
	resetDefaultRuntimeEnvForTests,
} from "../../src/runtime/env.js";
import {
	defaultSettings,
	resetDefaultSettingsForTests,
	resolveSettings,
} from "../../src/runtime/settings.js";

describe("resolveSettings", () => {
	afterEach(() => {
		resetDefaultSettingsForTests();
	});

	it("derives every section from RuntimeEnv when no overrides are passed", () => {
		const env = createRuntimeEnv({
			MAESTRO_LOG_LEVEL: "debug",
			MAESTRO_LOG_JSON: "1",
			MAESTRO_LOG_SPLIT_STREAMS: "1",
			MAESTRO_TELEMETRY: "1",
			MAESTRO_BEACON_FILE: "/tmp/beacon.jsonl",
			MAESTRO_METER_BASE: "http://meter.test/",
			MAESTRO_METER_ACCESS_TOKEN: "meter-token",
			MAESTRO_METER_ORGANIZATION_ID: "org_meter",
			MAESTRO_DISABLE_KEYCHAIN: "1",
			MAESTRO_EVALOPS_ORG_ID: "org_evalops",
			MAESTRO_EVALOPS_ACCESS_TOKEN: "evalops-token",
			MAESTRO_HOME: "/tmp/maestro",
		});
		const settings = resolveSettings({ env });

		expect(settings.logger.level).toBe("debug");
		expect(settings.logger.jsonFormat).toBe(true);
		expect(settings.logger.splitStreams).toBe(true);
		expect(settings.telemetry.enabled).toBe(true);
		expect(settings.telemetry.beaconFile).toBe("/tmp/beacon.jsonl");
		expect(settings.meter.baseUrl).toBe("http://meter.test/");
		expect(settings.meter.accessToken).toBe("meter-token");
		expect(settings.meter.organizationId).toBe("org_meter");
		expect(settings.oauth.disableKeychain).toBe(true);
		expect(settings.evalops.orgId).toBe("org_evalops");
		expect(settings.evalops.accessToken).toBe("evalops-token");
		expect(settings.maestro.home).toBe("/tmp/maestro");
	});

	it("freezes every nested section so consumers cannot mutate", () => {
		const settings = resolveSettings({ env: createRuntimeEnv({}) });
		expect(Object.isFrozen(settings)).toBe(true);
		expect(Object.isFrozen(settings.logger)).toBe(true);
		expect(Object.isFrozen(settings.telemetry)).toBe(true);
		expect(Object.isFrozen(settings.meter)).toBe(true);
		expect(Object.isFrozen(settings.oauth)).toBe(true);
		expect(Object.isFrozen(settings.evalops)).toBe(true);
		expect(Object.isFrozen(settings.maestro)).toBe(true);
	});

	it("CLI overrides take precedence over env-derived values", () => {
		const env = createRuntimeEnv({
			MAESTRO_LOG_LEVEL: "info",
			MAESTRO_METER_BASE: "http://env.test/",
		});
		const settings = resolveSettings({
			env,
			cliOverrides: {
				logger: { level: "debug" },
				meter: { baseUrl: "http://override.test/" },
			},
		});
		expect(settings.logger.level).toBe("debug");
		expect(settings.meter.baseUrl).toBe("http://override.test/");
	});

	it("CLI overrides at the leaf preserve unrelated env-derived fields", () => {
		// Override only `logger.level` — `jsonFormat` and `splitStreams`
		// should still come from env. The shape that breaks naive
		// `{...defaults, ...overrides}` merges.
		const env = createRuntimeEnv({
			MAESTRO_LOG_LEVEL: "info",
			MAESTRO_LOG_JSON: "1",
			MAESTRO_LOG_SPLIT_STREAMS: "1",
		});
		const settings = resolveSettings({
			env,
			cliOverrides: { logger: { level: "debug" } },
		});
		expect(settings.logger.level).toBe("debug");
		expect(settings.logger.jsonFormat).toBe(true);
		expect(settings.logger.splitStreams).toBe(true);
	});

	it("undefined overrides do NOT clobber base values (null still does)", () => {
		// A common bug surface: `{ enabled: undefined }` accidentally
		// overrides the env-derived `enabled: true` with undefined.
		// Settings substrate has to treat `undefined` as "no override" but
		// `null` as a real explicit value (the telemetry tri-state cares).
		const env = createRuntimeEnv({ MAESTRO_TELEMETRY: "1" });

		const undefinedOverride = resolveSettings({
			env,
			cliOverrides: { telemetry: { enabled: undefined } },
		});
		expect(undefinedOverride.telemetry.enabled).toBe(true);

		const nullOverride = resolveSettings({
			env,
			cliOverrides: { telemetry: { enabled: null } },
		});
		expect(nullOverride.telemetry.enabled).toBeNull();
	});

	it("substrate: hermetic — no process.env reads (verified by literal env)", () => {
		// The substrate guarantee: same input → same output, no ambient
		// reads. With an explicit RuntimeEnv literal, the result is
		// deterministic regardless of `process.env` state.
		const original = process.env.MAESTRO_LOG_LEVEL;
		process.env.MAESTRO_LOG_LEVEL = "debug";
		try {
			const env = createRuntimeEnv({ MAESTRO_LOG_LEVEL: "warn" });
			const settings = resolveSettings({ env });
			// Sees the explicit RuntimeEnv literal, not the live process.env.
			expect(settings.logger.level).toBe("warn");
		} finally {
			if (original === undefined) {
				Reflect.deleteProperty(process.env, "MAESTRO_LOG_LEVEL");
			} else {
				process.env.MAESTRO_LOG_LEVEL = original;
			}
		}
	});

	it("telemetry section captures beacon endpoint, sampleRate, timeoutMs, apiKey", () => {
		// PR #2772 timer-leak class is closed structurally only if the
		// telemetry consumer can take a complete `Settings["telemetry"]`
		// slice — no process.env-shaped fallback paths.
		const env = createRuntimeEnv({
			MAESTRO_TELEMETRY: "1",
			MAESTRO_BEACON_ENDPOINT: "https://beacon.test/",
			MAESTRO_BEACON_API_KEY: "secret-key",
			MAESTRO_BEACON_TIMEOUT_MS: "250",
			MAESTRO_TELEMETRY_SAMPLE: "0.5",
		});
		const settings = resolveSettings({ env });
		expect(settings.telemetry.enabled).toBe(true);
		expect(settings.telemetry.endpoint).toBe("https://beacon.test/");
		expect(settings.telemetry.apiKey).toBe("secret-key");
		expect(settings.telemetry.timeoutMs).toBe(250);
		expect(settings.telemetry.sampleRate).toBe(0.5);
	});

	it("telemetry endpoint falls through alias list (Playwright vars)", () => {
		// Substrate guarantee: alias resolution lives on RuntimeEnv only.
		// Settings inherits it — no parallel alias table.
		const envPlaywright = createRuntimeEnv({
			PLAYWRIGHT_TELEMETRY_ENDPOINT: "https://playwright.test/",
		});
		expect(resolveSettings({ env: envPlaywright }).telemetry.endpoint).toBe(
			"https://playwright.test/",
		);

		const envBoth = createRuntimeEnv({
			MAESTRO_BEACON_ENDPOINT: "primary",
			PLAYWRIGHT_TELEMETRY_ENDPOINT: "should-lose",
		});
		expect(resolveSettings({ env: envBoth }).telemetry.endpoint).toBe(
			"primary",
		);
	});

	it("telemetry sampleRate clamps to [0, 1] and null-cases unparseable values", () => {
		expect(
			resolveSettings({
				env: createRuntimeEnv({ MAESTRO_TELEMETRY_SAMPLE: "1.5" }),
			}).telemetry.sampleRate,
		).toBe(1);
		expect(
			resolveSettings({
				env: createRuntimeEnv({ MAESTRO_TELEMETRY_SAMPLE: "-0.2" }),
			}).telemetry.sampleRate,
		).toBe(0);
		expect(
			resolveSettings({
				env: createRuntimeEnv({ MAESTRO_TELEMETRY_SAMPLE: "not-a-number" }),
			}).telemetry.sampleRate,
		).toBeNull();
	});

	it("CLI override on telemetry.sampleRate wins over env value", () => {
		const env = createRuntimeEnv({ MAESTRO_TELEMETRY_SAMPLE: "0.5" });
		const settings = resolveSettings({
			env,
			cliOverrides: { telemetry: { sampleRate: 1 } },
		});
		expect(settings.telemetry.sampleRate).toBe(1);
	});

	it("alias-list resolution flows through env: EvalOps org-id from any of the four sources", () => {
		// Validates that Settings doesn't re-implement the alias logic —
		// it inherits from RuntimeEnv. The same alias-list-walking
		// happens once, at RuntimeEnv construction.
		expect(
			resolveSettings({
				env: createRuntimeEnv({ EVALOPS_ORG_ID: "runner-leak" }),
			}).evalops.orgId,
		).toBe("runner-leak");
		expect(
			resolveSettings({
				env: createRuntimeEnv({
					MAESTRO_EVALOPS_ORG_ID: "primary",
					EVALOPS_ORG_ID: "should-lose",
				}),
			}).evalops.orgId,
		).toBe("primary");
	});
});

describe("defaultSettings", () => {
	afterEach(() => {
		resetDefaultSettingsForTests();
	});

	it("returns the same instance on repeated calls (cached)", () => {
		expect(defaultSettings()).toBe(defaultSettings());
	});

	it("rebuilds after reset", () => {
		const a = defaultSettings();
		resetDefaultSettingsForTests();
		expect(defaultSettings()).not.toBe(a);
	});

	it("rebuilds after the default runtime env cache is reset", () => {
		process.env.MAESTRO_LOG_LEVEL = "debug";
		const a = defaultSettings();
		expect(a.logger.level).toBe("debug");

		process.env.MAESTRO_LOG_LEVEL = "error";
		resetDefaultRuntimeEnvForTests();

		const b = defaultSettings();
		expect(b).not.toBe(a);
		expect(b.logger.level).toBe("error");
	});
});
