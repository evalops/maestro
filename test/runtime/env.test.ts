import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createRuntimeEnv,
	defaultRuntimeEnv,
	isRuntimeEnvFinalized,
	resetDefaultRuntimeEnvForTests,
} from "../../src/runtime/env.js";

describe("createRuntimeEnv", () => {
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

	afterEach(() => {
		resetDefaultRuntimeEnvForTests();
		if (originalPlatform) {
			Object.defineProperty(process, "platform", originalPlatform);
		}
	});

	function stubPlatform(platform: NodeJS.Platform): void {
		Object.defineProperty(process, "platform", {
			value: platform,
		});
	}

	it("returns sensible defaults for empty env", () => {
		const env = createRuntimeEnv({});
		expect(env.logLevel).toBe("info");
		expect(env.logJsonFormat).toBe(false);
		expect(env.logSplitStreams).toBe(false);
		expect(env.evalopsOrgId).toBeNull();
		expect(env.evalopsAccessToken).toBeNull();
		expect(env.disableKeychain).toBe(false);
		expect(env.maestroAgentDir).toBeNull();
		expect(env.skillTrustStrict).toBe(false);
		expect(env.telemetryEnabled).toBeNull();
		expect(env.beaconFile).toBeNull();
		expect(env.cliCommandBeaconBufferFile).toBeNull();
		expect(env.meterBaseUrl).toBeNull();
		expect(env.meterAccessToken).toBeNull();
		expect(env.meterOrganizationId).toBeNull();
		expect(env.ambientLearnerFile).toBeNull();
		expect(env.ambientLearnerDefaultFile).toContain(
			join("ambient-agent", "learner.json"),
		);
		expect(env.ambientSocketFile).toContain("ambient-agent.sock");
	});

	it("matches the ambient daemon learner default data path", () => {
		const home = "/tmp/maestro-runtime-home";
		const xdgDataHome = "/tmp/maestro-runtime-xdg";
		const tmpRuntime = "/tmp/maestro-runtime-tmp";
		const env = createRuntimeEnv({
			HOME: home,
			TMPDIR: tmpRuntime,
			XDG_DATA_HOME: xdgDataHome,
		});
		if (process.platform === "darwin") {
			expect(env.ambientLearnerDefaultFile).toBe(
				join(
					home,
					"Library",
					"Application Support",
					"ambient-agent",
					"learner.json",
				),
			);
			expect(env.ambientSocketFile).toBe(
				join(home, "Library", "Application Support", "ambient-agent.sock"),
			);
		} else if (process.platform === "win32") {
			expect(env.ambientLearnerDefaultFile).toBe(
				join(home, "AppData", "Local", "ambient-agent", "learner.json"),
			);
			expect(env.ambientSocketFile).toBe(
				join(home, "AppData", "Local", "ambient-agent.sock"),
			);
		} else {
			expect(env.ambientLearnerDefaultFile).toBe(
				join(xdgDataHome, "ambient-agent", "learner.json"),
			);
			expect(env.ambientSocketFile).toBe(
				join(xdgDataHome, "ambient-agent.sock"),
			);
		}
		expect(
			createRuntimeEnv({
				HOME: home,
				MAESTRO_AMBIENT_LEARNER_FILE: "~/custom-learner.json",
			}).ambientLearnerFile,
		).toBe(join(home, "custom-learner.json"));
	});

	it("matches the ambient daemon socket runtime path on macOS", () => {
		stubPlatform("darwin");
		const home = "/tmp/maestro-runtime-home";
		const tmpRuntime = "/tmp/maestro-runtime-tmp";
		const xdgRuntime = "/tmp/maestro-runtime-xdg-runtime";
		const env = createRuntimeEnv({
			HOME: home,
			TMPDIR: tmpRuntime,
			XDG_RUNTIME_DIR: xdgRuntime,
		});
		expect(env.ambientLearnerDefaultFile).toBe(
			join(
				home,
				"Library",
				"Application Support",
				"ambient-agent",
				"learner.json",
			),
		);
		expect(env.ambientSocketFile).toBe(
			join(home, "Library", "Application Support", "ambient-agent.sock"),
		);
	});

	it("parses log level only from the documented set", () => {
		expect(createRuntimeEnv({ MAESTRO_LOG_LEVEL: "debug" }).logLevel).toBe(
			"debug",
		);
		expect(createRuntimeEnv({ MAESTRO_LOG_LEVEL: "warn" }).logLevel).toBe(
			"warn",
		);
		// Anything outside the documented set falls back, instead of leaking
		// arbitrary strings into the type-checker's blind spot.
		expect(createRuntimeEnv({ MAESTRO_LOG_LEVEL: "verbose" }).logLevel).toBe(
			"info",
		);
		expect(createRuntimeEnv({ MAESTRO_LOG_LEVEL: "" }).logLevel).toBe("info");
	});

	it("parses booleans only from `1`/`true`", () => {
		expect(createRuntimeEnv({ MAESTRO_LOG_JSON: "1" }).logJsonFormat).toBe(
			true,
		);
		expect(createRuntimeEnv({ MAESTRO_LOG_JSON: "true" }).logJsonFormat).toBe(
			true,
		);
		expect(createRuntimeEnv({ MAESTRO_LOG_JSON: "yes" }).logJsonFormat).toBe(
			false,
		);
		expect(createRuntimeEnv({ MAESTRO_LOG_JSON: "0" }).logJsonFormat).toBe(
			false,
		);
		expect(
			createRuntimeEnv({ MAESTRO_SKILL_TRUST_STRICT: "1" }).skillTrustStrict,
		).toBe(true);
		expect(
			createRuntimeEnv({ MAESTRO_SKILL_TRUST_STRICT: "false" })
				.skillTrustStrict,
		).toBe(false);
	});

	it("resolves evalopsOrgId from the documented alias list in priority order", () => {
		// This is the surface PR #2763 closed — the meter test was failing on
		// runner-1 because EVALOPS_ORG_ID was set in the runner env.
		expect(
			createRuntimeEnv({
				MAESTRO_EVALOPS_ORG_ID: "primary",
				EVALOPS_ORGANIZATION_ID: "secondary",
				EVALOPS_ORG_ID: "tertiary",
				MAESTRO_ENTERPRISE_ORG_ID: "quaternary",
			}).evalopsOrgId,
		).toBe("primary");
		expect(
			createRuntimeEnv({
				EVALOPS_ORGANIZATION_ID: "secondary",
				EVALOPS_ORG_ID: "tertiary",
			}).evalopsOrgId,
		).toBe("secondary");
		expect(createRuntimeEnv({ EVALOPS_ORG_ID: "tertiary" }).evalopsOrgId).toBe(
			"tertiary",
		);
		expect(
			createRuntimeEnv({ MAESTRO_ENTERPRISE_ORG_ID: "quaternary" })
				.evalopsOrgId,
		).toBe("quaternary");
	});

	it("treats whitespace-only env values as unset", () => {
		// Otherwise CI runners that export `EVALOPS_ORG_ID=" "` leak in.
		expect(
			createRuntimeEnv({ MAESTRO_EVALOPS_ORG_ID: "   " }).evalopsOrgId,
		).toBeNull();
		expect(createRuntimeEnv({ MAESTRO_HOME: "  " }).maestroHome).not.toBe("  ");
	});

	it("trims values around the edges (matches the OAuth alias readers)", () => {
		expect(
			createRuntimeEnv({ MAESTRO_EVALOPS_ORG_ID: "  org_42  " }).evalopsOrgId,
		).toBe("org_42");
	});

	it("returns frozen objects so accidental mutation throws in strict mode", () => {
		const env = createRuntimeEnv({});
		expect(Object.isFrozen(env)).toBe(true);
	});

	it("models telemetryEnabled as a tri-state (null = unset)", () => {
		// Distinguishes "user opted in" (1) from "user opted out" (0) from
		// "no preference set" (null) — the same shape isBeaconEnabled relies on.
		expect(createRuntimeEnv({ MAESTRO_TELEMETRY: "1" }).telemetryEnabled).toBe(
			true,
		);
		expect(createRuntimeEnv({ MAESTRO_TELEMETRY: "0" }).telemetryEnabled).toBe(
			false,
		);
		expect(createRuntimeEnv({}).telemetryEnabled).toBeNull();
		// `PLAYWRIGHT_TELEMETRY` is the documented legacy alias the beacon
		// code consulted before this substrate existed.
		expect(
			createRuntimeEnv({ PLAYWRIGHT_TELEMETRY: "true" }).telemetryEnabled,
		).toBe(true);
		expect(
			createRuntimeEnv({ MAESTRO_TELEMETRY: "FALSE" }).telemetryEnabled,
		).toBe(false);
		expect(
			createRuntimeEnv({ PLAYWRIGHT_TELEMETRY: "TrUe" }).telemetryEnabled,
		).toBe(true);
		expect(
			createRuntimeEnv({
				MAESTRO_TELEMETRY: "1",
				PLAYWRIGHT_TELEMETRY: "false",
			}).telemetryEnabled,
		).toBe(true);
	});

	it("resolves beacon endpoint, apiKey, timeoutMs, sampleRate to typed fields", () => {
		const env = createRuntimeEnv({
			MAESTRO_BEACON_ENDPOINT: "https://beacon.test/",
			MAESTRO_BEACON_API_KEY: "secret-key",
			MAESTRO_BEACON_TIMEOUT_MS: "250",
			MAESTRO_TELEMETRY_SAMPLE: "0.5",
		});
		expect(env.beaconEndpoint).toBe("https://beacon.test/");
		expect(env.beaconApiKey).toBe("secret-key");
		expect(env.beaconTimeoutMs).toBe(250);
		expect(env.telemetrySampleRate).toBe(0.5);
	});

	it("beacon endpoint walks the documented alias list (MAESTRO > MAESTRO_TELEMETRY > PLAYWRIGHT)", () => {
		expect(
			createRuntimeEnv({
				MAESTRO_TELEMETRY_ENDPOINT: "https://telemetry.test/",
			}).beaconEndpoint,
		).toBe("https://telemetry.test/");
		expect(
			createRuntimeEnv({
				PLAYWRIGHT_TELEMETRY_ENDPOINT: "https://playwright.test/",
			}).beaconEndpoint,
		).toBe("https://playwright.test/");
		expect(
			createRuntimeEnv({
				MAESTRO_BEACON_ENDPOINT: "primary",
				MAESTRO_TELEMETRY_ENDPOINT: "should-lose",
				PLAYWRIGHT_TELEMETRY_ENDPOINT: "should-also-lose",
			}).beaconEndpoint,
		).toBe("primary");
	});

	it("beaconTimeoutMs rejects 0 and negative; sampleRate clamps and rejects non-numeric", () => {
		expect(
			createRuntimeEnv({ MAESTRO_BEACON_TIMEOUT_MS: "0" }).beaconTimeoutMs,
		).toBeNull();
		expect(
			createRuntimeEnv({ MAESTRO_BEACON_TIMEOUT_MS: "-5" }).beaconTimeoutMs,
		).toBeNull();
		expect(
			createRuntimeEnv({ MAESTRO_BEACON_TIMEOUT_MS: "abc" }).beaconTimeoutMs,
		).toBeNull();
		expect(
			createRuntimeEnv({ MAESTRO_TELEMETRY_SAMPLE: "2" }).telemetrySampleRate,
		).toBe(1);
		expect(
			createRuntimeEnv({ MAESTRO_TELEMETRY_SAMPLE: "-1" }).telemetrySampleRate,
		).toBe(0);
		expect(
			createRuntimeEnv({ MAESTRO_TELEMETRY_SAMPLE: "abc" }).telemetrySampleRate,
		).toBeNull();
	});

	it("beaconFile expands leading `~` using HOME/USERPROFILE semantics", () => {
		const homeDir = join(homedir(), "custom-home");
		expect(
			createRuntimeEnv({
				HOME: homeDir,
				MAESTRO_BEACON_FILE: "~/my-beacon.jsonl",
			}).beaconFile,
		).toBe(join(homeDir, "my-beacon.jsonl"));
		expect(
			createRuntimeEnv({
				HOME: homeDir,
				MAESTRO_BEACON_FILE: "~\\my-beacon.jsonl",
			}).beaconFile,
		).toBe(join(homeDir, "my-beacon.jsonl"));
	});

	it("beaconFile expands `~\\` at the substrate boundary to preserve Windows-style home-relative paths", () => {
		const env = createRuntimeEnv({ MAESTRO_BEACON_FILE: "~\\my-beacon.jsonl" });
		expect(env.beaconFile).toBe(join(homedir(), "my-beacon.jsonl"));
	});

	it("captures MAESTRO_OTEL_* SDK-boot env vars as typed RuntimeEnv fields", () => {
		// `src/opentelemetry.ts` previously scattered these as direct
		// process.env reads. The substrate snapshot makes the enable
		// flag + sampler + service name a single frozen value at boot.
		const env = createRuntimeEnv({
			MAESTRO_OTEL: "1",
			MAESTRO_OTEL_SAMPLER: "always_on",
			MAESTRO_OTEL_SERVICE_NAME: "my-service",
		});
		expect(env.otelEnabled).toBe(true);
		expect(env.otelFlag).toBe("1");
		expect(env.otelSampler).toBe("always_on");
		expect(env.otelServiceName).toBe("my-service");
	});

	it("otelEnabled is tri-state: 1 / 0 / null (no signal)", () => {
		expect(createRuntimeEnv({ MAESTRO_OTEL: "1" }).otelEnabled).toBe(true);
		expect(createRuntimeEnv({ MAESTRO_OTEL: "true" }).otelEnabled).toBe(true);
		expect(createRuntimeEnv({ MAESTRO_OTEL: "0" }).otelEnabled).toBe(false);
		expect(createRuntimeEnv({ MAESTRO_OTEL: "false" }).otelEnabled).toBe(false);
		expect(createRuntimeEnv({}).otelEnabled).toBeNull();
	});

	it("otelFlag preserves the raw user string for status diagnostics", () => {
		expect(createRuntimeEnv({ MAESTRO_OTEL: "1" }).otelFlag).toBe("1");
		expect(createRuntimeEnv({ MAESTRO_OTEL: "0" }).otelFlag).toBe("0");
		expect(createRuntimeEnv({}).otelFlag).toBeNull();
	});

	it("exposes OTel exporter file/endpoint as typed fields distinct from beacon equivalents", () => {
		// The OTel exporter (src/telemetry.ts) has historically read
		// MAESTRO_TELEMETRY_FILE and MAESTRO_TELEMETRY_ENDPOINT as
		// module-load-time process.env reads. After substrate migration
		// these are typed fields on RuntimeEnv.
		const env = createRuntimeEnv({
			MAESTRO_TELEMETRY_FILE: "/tmp/otel.log",
			MAESTRO_TELEMETRY_ENDPOINT: "https://otel.test/",
		});
		expect(env.exporterFile).toBe("/tmp/otel.log");
		expect(env.exporterEndpoint).toBe("https://otel.test/");
	});

	it("exporter fields fall back to the Playwright aliases (legacy behavior)", () => {
		expect(
			createRuntimeEnv({ PLAYWRIGHT_TELEMETRY_FILE: "/tmp/pw.log" })
				.exporterFile,
		).toBe("/tmp/pw.log");
		expect(
			createRuntimeEnv({
				PLAYWRIGHT_TELEMETRY_ENDPOINT: "https://pw.test/",
			}).exporterEndpoint,
		).toBe("https://pw.test/");
		// MAESTRO_TELEMETRY_FILE wins over PLAYWRIGHT_TELEMETRY_FILE.
		expect(
			createRuntimeEnv({
				MAESTRO_TELEMETRY_FILE: "primary",
				PLAYWRIGHT_TELEMETRY_FILE: "should-lose",
			}).exporterFile,
		).toContain("primary");
	});

	it("exporterEndpoint is NOT redirected by MAESTRO_BEACON_ENDPOINT", () => {
		// The beacon's primary endpoint var must not also point the OTel
		// exporter — these are independent layers.
		const env = createRuntimeEnv({
			MAESTRO_BEACON_ENDPOINT: "https://beacon-only.test/",
		});
		expect(env.beaconEndpoint).toBe("https://beacon-only.test/");
		expect(env.exporterEndpoint).toBeNull();
	});

	it("telemetryFlag preserves the raw user string for diagnostics", () => {
		// `telemetryEnabled` is the parsed tri-state; `telemetryFlag` is
		// the raw string surfaced in `getTelemetryStatus().flagValue`.
		expect(createRuntimeEnv({ MAESTRO_TELEMETRY: "1" }).telemetryFlag).toBe(
			"1",
		);
		expect(
			createRuntimeEnv({ PLAYWRIGHT_TELEMETRY: "true" }).telemetryFlag,
		).toBe("true");
		expect(createRuntimeEnv({}).telemetryFlag).toBeNull();
	});

	it("beaconFile honors HOME from the snapshot (matches legacy resolveEnvPath behavior)", () => {
		// The legacy resolveEnvPath consulted process.env.HOME before
		// homedir(). Tests pinning HOME to a temp dir must still see
		// the tilde expand against that override after migration.
		const env = createRuntimeEnv({
			HOME: "/tmp/my-test-home",
			MAESTRO_BEACON_FILE: "~/beacon.jsonl",
		});
		expect(env.beaconFile).toBe("/tmp/my-test-home/beacon.jsonl");
	});

	it("resolves meterOrganizationId through MAESTRO_METER_ORGANIZATION_ID then the EvalOps alias list", () => {
		expect(
			createRuntimeEnv({
				MAESTRO_METER_ORGANIZATION_ID: "meter-org",
				MAESTRO_EVALOPS_ORG_ID: "evalops-org",
			}).meterOrganizationId,
		).toBe("meter-org");
		expect(
			createRuntimeEnv({
				MAESTRO_EVALOPS_ORG_ID: "evalops-org",
			}).meterOrganizationId,
		).toBe("evalops-org");
		// The bug from #2763: EVALOPS_ORG_ID alone leaks through when other
		// vars are cleared. The substrate captures it explicitly so callers
		// can't forget it exists.
		expect(
			createRuntimeEnv({ EVALOPS_ORG_ID: "runner-leak" }).meterOrganizationId,
		).toBe("runner-leak");
	});
});

describe("defaultRuntimeEnv", () => {
	afterEach(() => {
		resetDefaultRuntimeEnvForTests();
	});

	it("returns the same instance on repeated calls (snapshot semantics)", () => {
		const a = defaultRuntimeEnv();
		const b = defaultRuntimeEnv();
		expect(a).toBe(b);
	});

	it("rebuilds the snapshot after resetDefaultRuntimeEnvForTests", () => {
		const a = defaultRuntimeEnv();
		resetDefaultRuntimeEnvForTests();
		const b = defaultRuntimeEnv();
		expect(a).not.toBe(b);
	});

	it("throws on pre-finalization snapshots when strict bootstrap mode is enabled", () => {
		const previous = process.env.MAESTRO_RUNTIME_ENV_STRICT_BOOTSTRAP;
		try {
			process.env.MAESTRO_RUNTIME_ENV_STRICT_BOOTSTRAP = "1";
			expect(() => defaultRuntimeEnv()).toThrow(
				"defaultRuntimeEnv() was read before loadAndFinalizeEnv() completed",
			);
			expect(isRuntimeEnvFinalized()).toBe(false);
		} finally {
			if (previous === undefined) {
				Reflect.deleteProperty(
					process.env,
					"MAESTRO_RUNTIME_ENV_STRICT_BOOTSTRAP",
				);
			} else {
				process.env.MAESTRO_RUNTIME_ENV_STRICT_BOOTSTRAP = previous;
			}
		}
	});
});
