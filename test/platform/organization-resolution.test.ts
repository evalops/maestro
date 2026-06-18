import { describe, expect, it } from "vitest";
import {
	resolveOrganizationIdFromEnv,
	resolveOrganizationIdFromOAuthCredentials,
} from "../../src/platform/client.js";
import { createRuntimeEnv } from "../../src/runtime/env.js";

describe("resolveOrganizationIdFromEnv (substrate primitive)", () => {
	it("returns null when no env vars are set", () => {
		const env = createRuntimeEnv({});
		expect(resolveOrganizationIdFromEnv(env)).toBeUndefined();
	});

	it("resolves the documented alias list in priority order", () => {
		// This is the surface PR #2763 closed — runner-env leaking
		// `EVALOPS_ORG_ID` past tests that forgot to clear it. With the
		// substrate, the alias list is walked ONCE at RuntimeEnv
		// construction; the function itself never touches process.env.
		expect(
			resolveOrganizationIdFromEnv(
				createRuntimeEnv({ MAESTRO_EVALOPS_ORG_ID: "primary" }),
			),
		).toBe("primary");
		expect(
			resolveOrganizationIdFromEnv(
				createRuntimeEnv({ EVALOPS_ORGANIZATION_ID: "secondary" }),
			),
		).toBe("secondary");
		expect(
			resolveOrganizationIdFromEnv(
				createRuntimeEnv({ EVALOPS_ORG_ID: "runner-leak" }),
			),
		).toBe("runner-leak");
		expect(
			resolveOrganizationIdFromEnv(
				createRuntimeEnv({ MAESTRO_ENTERPRISE_ORG_ID: "enterprise" }),
			),
		).toBe("enterprise");
	});

	it("higher-priority aliases override lower-priority ones", () => {
		const env = createRuntimeEnv({
			MAESTRO_EVALOPS_ORG_ID: "primary",
			EVALOPS_ORGANIZATION_ID: "secondary",
			EVALOPS_ORG_ID: "tertiary",
			MAESTRO_ENTERPRISE_ORG_ID: "quaternary",
		});
		expect(resolveOrganizationIdFromEnv(env)).toBe("primary");
	});
});

describe("resolveOrganizationIdFromOAuthCredentials (substrate primitive)", () => {
	it("returns undefined when no OAuth credentials are stored", () => {
		// In a hermetic test env (MAESTRO_DISABLE_KEYCHAIN=1 + temp MAESTRO_HOME
		// set by the worker-level restore-oauth-storage.ts), no credentials
		// exist on disk and the function returns undefined cleanly.
		expect(resolveOrganizationIdFromOAuthCredentials()).toBeUndefined();
	});
});
