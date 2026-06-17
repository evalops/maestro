import { describe, expect, it } from "vitest";
import { applyShellEnvironmentPolicy } from "../../src/utils/shell-env.js";

/**
 * Coverage for the widened DEFAULT_EXCLUDES denylist landed for
 * #2471. These tests pin the "secrets that the old 3-pattern list
 * silently let through" so a regression on the defaults trips the
 * suite immediately.
 *
 * The acceptance criterion from #2471: "Test asserting a non-
 * KEY/SECRET/TOKEN secret (e.g. DATABASE_URL with inline password)
 * is excluded under the recommended config."
 */
describe("shell-env DEFAULT_EXCLUDES (#2471)", () => {
	function policyExcludes(name: string, value: string): boolean {
		const env = applyShellEnvironmentPolicy({ [name]: value });
		return !(name in env);
	}

	it("still excludes original triad (KEY/SECRET/TOKEN)", () => {
		expect(policyExcludes("OPENAI_API_KEY", "sk-...")).toBe(true);
		expect(policyExcludes("MY_SECRET", "s")).toBe(true);
		expect(policyExcludes("MY_TOKEN", "t")).toBe(true);
	});

	it("excludes credential-noun patterns", () => {
		expect(policyExcludes("DB_PASSWORD", "pw")).toBe(true);
		expect(policyExcludes("REDIS_PASSWD", "pw")).toBe(true);
		expect(policyExcludes("MY_CREDENTIAL", "c")).toBe(true);
		expect(policyExcludes("PRIVATE_KEY_PEM", "pk")).toBe(true);
	});

	it("excludes PAT-style env names without matching PATH", () => {
		expect(policyExcludes("GITHUB_PAT", "ghp_")).toBe(true);
		expect(policyExcludes("GH_PAT", "ghp_")).toBe(true);
		expect(policyExcludes("PAT_TOKEN", "ghp_")).toBe(true);

		// PATH must survive — the whole shell breaks without it
		const env = applyShellEnvironmentPolicy({ PATH: "/usr/bin" });
		expect(env.PATH).toBe("/usr/bin");
	});

	it("excludes AUTH variants", () => {
		expect(policyExcludes("BASIC_AUTH", "U:P")).toBe(true);
		expect(policyExcludes("HTTP_AUTH_BEARER", "Bearer x")).toBe(true);
		expect(policyExcludes("AUTH_HEADER", "Bearer x")).toBe(true);
	});

	it("excludes DSN-style connection strings (the headline case)", () => {
		// This is the canonical acceptance-criteria example from #2471
		expect(policyExcludes("DATABASE_URL", "REDACTED")).toBe(true);
		expect(policyExcludes("DB_URL", "REDACTED")).toBe(true);
		expect(policyExcludes("REDIS_DSN", "REDACTED")).toBe(true);
		expect(policyExcludes("CONNECTION_STRING", "Server=...;User=...")).toBe(
			true,
		);
		expect(policyExcludes("PRIMARY_DATABASE_URL", "REDACTED")).toBe(true);
	});

	it("excludes secret-prone provider prefixes", () => {
		expect(policyExcludes("AWS_ACCESS_KEY_ID", "AKIA...")).toBe(true);
		expect(policyExcludes("AWS_SECRET_ACCESS_KEY", "...")).toBe(true);
		expect(policyExcludes("AWS_REGION", "us-east-1")).toBe(true);
		expect(policyExcludes("AZURE_CLIENT_SECRET", "x")).toBe(true);
		expect(policyExcludes("GCP_PROJECT_NAME", "x")).toBe(true);
		expect(policyExcludes("OPENAI_API_KEY", "x")).toBe(true);
		expect(policyExcludes("ANTHROPIC_API_KEY", "x")).toBe(true);
		expect(policyExcludes("STRIPE_PUBLISHABLE_KEY", "pk_...")).toBe(true);
		expect(policyExcludes("OP_SESSION_my_account", "x")).toBe(true);
	});

	it("does NOT exclude common GitHub CI vars (heavily used non-secret)", () => {
		const env = applyShellEnvironmentPolicy({
			GITHUB_REPOSITORY: "evalops/maestro-internal",
			GITHUB_RUN_ID: "12345",
			GH_PAGER: "cat",
		});
		expect(env.GITHUB_REPOSITORY).toBe("evalops/maestro-internal");
		expect(env.GITHUB_RUN_ID).toBe("12345");
		expect(env.GH_PAGER).toBe("cat");
	});

	it("does still catch GITHUB_TOKEN via the *TOKEN* pattern", () => {
		expect(policyExcludes("GITHUB_TOKEN", "ghs_...")).toBe(true);
	});

	it("respects ignore_default_excludes opt-out for headless environments", () => {
		const env = applyShellEnvironmentPolicy(
			{ DATABASE_URL: "REDACTED" },
			{ inherit: "all", ignore_default_excludes: true },
		);
		expect(env.DATABASE_URL).toBe("REDACTED");
	});

	it("supports allowlist mode via include_only (the secure posture)", () => {
		// The recommended secure posture from #2471: explicit
		// allowlist rather than denylist. `inherit: "all"` +
		// `include_only` keeps only the named vars, dropping every
		// other variable regardless of name shape.
		const env = applyShellEnvironmentPolicy(
			{
				PATH: "/usr/bin",
				HOME: "/home/u",
				DATABASE_URL: "REDACTED",
				MY_CUSTOM_VAR: "x",
				WORKSPACE_ID: "wks-1",
			},
			{
				inherit: "all",
				include_only: ["WORKSPACE_ID", "PATH"],
			},
		);
		expect(env.WORKSPACE_ID).toBe("wks-1");
		expect(env.PATH).toBe("/usr/bin");
		expect(env.DATABASE_URL).toBeUndefined();
		expect(env.MY_CUSTOM_VAR).toBeUndefined();
		expect(env.HOME).toBeUndefined();
	});

	it("`inherit: core` strips even non-secret extras (defense in depth)", () => {
		const env = applyShellEnvironmentPolicy(
			{
				PATH: "/usr/bin",
				HOME: "/home/u",
				MY_CUSTOM_VAR: "x",
				DATABASE_URL: "REDACTED",
			},
			{ inherit: "core" },
		);
		expect(env.PATH).toBe("/usr/bin");
		expect(env.HOME).toBe("/home/u");
		expect(env.MY_CUSTOM_VAR).toBeUndefined();
		expect(env.DATABASE_URL).toBeUndefined();
	});
});
