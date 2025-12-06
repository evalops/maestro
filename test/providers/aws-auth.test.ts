import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildBedrockUrl,
	getAwsRegion,
	getBedrockStatus,
	hasAwsCredentials,
	isInferenceProfile,
	parseBedrockArn,
} from "../../src/providers/aws-auth.js";

describe("AWS Auth Helpers", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		// Reset environment for each test
		process.env = { ...originalEnv };
		process.env.AWS_ACCESS_KEY_ID = undefined;
		process.env.AWS_SECRET_ACCESS_KEY = undefined;
		process.env.AWS_SESSION_TOKEN = undefined;
		process.env.AWS_REGION = undefined;
		process.env.AWS_DEFAULT_REGION = undefined;
		process.env.AWS_PROFILE = undefined;
		process.env.AWS_SSO_SESSION_NAME = undefined;
		process.env.AWS_WEB_IDENTITY_TOKEN_FILE = undefined;
		process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = undefined;
		process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = undefined;
		process.env.AWS_BEARER_TOKEN_BEDROCK = undefined;
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	describe("hasAwsCredentials", () => {
		it("returns false when no credentials are set", () => {
			expect(hasAwsCredentials()).toBe(false);
		});

		it("returns true when access key ID is set", () => {
			process.env.AWS_ACCESS_KEY_ID = "test-access-key-id";
			expect(hasAwsCredentials()).toBe(true);
		});

		it("returns true when AWS profile is set", () => {
			process.env.AWS_PROFILE = "default";
			expect(hasAwsCredentials()).toBe(true);
		});

		it("returns true when SSO session name is set", () => {
			process.env.AWS_SSO_SESSION_NAME = "my-sso-session";
			expect(hasAwsCredentials()).toBe(true);
		});

		it("returns true when web identity token file is set (EKS)", () => {
			process.env.AWS_WEB_IDENTITY_TOKEN_FILE = "/var/run/secrets/token";
			expect(hasAwsCredentials()).toBe(true);
		});

		it("returns true when container credentials relative URI is set (ECS)", () => {
			process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI =
				"/v2/credentials/uuid";
			expect(hasAwsCredentials()).toBe(true);
		});

		it("returns true when container credentials full URI is set (ECS anywhere)", () => {
			process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI =
				"http://localhost:1234/credentials";
			expect(hasAwsCredentials()).toBe(true);
		});
	});

	describe("getAwsRegion", () => {
		it("returns us-east-1 as default", () => {
			expect(getAwsRegion()).toBe("us-east-1");
		});

		it("returns AWS_REGION when set", () => {
			process.env.AWS_REGION = "us-west-2";
			expect(getAwsRegion()).toBe("us-west-2");
		});

		it("returns AWS_DEFAULT_REGION when AWS_REGION is not set", () => {
			process.env.AWS_DEFAULT_REGION = "eu-west-1";
			expect(getAwsRegion()).toBe("eu-west-1");
		});

		it("prefers AWS_REGION over AWS_DEFAULT_REGION", () => {
			process.env.AWS_REGION = "us-west-2";
			process.env.AWS_DEFAULT_REGION = "eu-west-1";
			expect(getAwsRegion()).toBe("us-west-2");
		});
	});

	describe("buildBedrockUrl", () => {
		it("builds streaming URL correctly", () => {
			const url = buildBedrockUrl(
				"us-east-1",
				"anthropic.claude-3-sonnet-v1",
				true,
			);
			expect(url).toBe(
				"https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-sonnet-v1/converse-stream",
			);
		});

		it("builds non-streaming URL correctly", () => {
			const url = buildBedrockUrl(
				"us-west-2",
				"anthropic.claude-3-sonnet-v1",
				false,
			);
			expect(url).toBe(
				"https://bedrock-runtime.us-west-2.amazonaws.com/model/anthropic.claude-3-sonnet-v1/converse",
			);
		});

		it("encodes model ID with special characters", () => {
			const url = buildBedrockUrl("us-east-1", "writer.palmyra-x5-v1:0", true);
			expect(url).toBe(
				"https://bedrock-runtime.us-east-1.amazonaws.com/model/writer.palmyra-x5-v1%3A0/converse-stream",
			);
		});

		it("handles different regions", () => {
			const regions = ["us-east-1", "us-west-2", "eu-west-1", "ap-northeast-1"];
			for (const region of regions) {
				const url = buildBedrockUrl(region, "test-model", true);
				expect(url).toContain(`bedrock-runtime.${region}.amazonaws.com`);
			}
		});

		it("defaults to streaming when not specified", () => {
			const url = buildBedrockUrl("us-east-1", "test-model");
			expect(url).toContain("/converse-stream");
		});
	});

	describe("parseBedrockArn", () => {
		it("returns null for non-ARN model IDs", () => {
			expect(parseBedrockArn("anthropic.claude-3-sonnet-v1")).toBeNull();
			expect(parseBedrockArn("writer.palmyra-x5-v1:0")).toBeNull();
		});

		it("parses foundation model ARNs", () => {
			const result = parseBedrockArn(
				"arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-3-sonnet-v1",
			);
			expect(result).toEqual({
				region: "us-west-2",
				accountId: "",
				resourceType: "foundation-model",
				resourceId: "anthropic.claude-3-sonnet-v1",
			});
		});

		it("parses inference profile ARNs", () => {
			const result = parseBedrockArn(
				"arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-3-5-sonnet-v2",
			);
			expect(result).toEqual({
				region: "us-east-1",
				accountId: "123456789012",
				resourceType: "inference-profile",
				resourceId: "us.anthropic.claude-3-5-sonnet-v2",
			});
		});

		it("parses provisioned model ARNs", () => {
			const result = parseBedrockArn(
				"arn:aws:bedrock:eu-west-1:987654321098:provisioned-model/my-model-xyz",
			);
			expect(result).toEqual({
				region: "eu-west-1",
				accountId: "987654321098",
				resourceType: "provisioned-model",
				resourceId: "my-model-xyz",
			});
		});
	});

	describe("isInferenceProfile", () => {
		it("returns true for US inference profiles", () => {
			expect(isInferenceProfile("us.anthropic.claude-3-5-sonnet-v2:0")).toBe(
				true,
			);
		});

		it("returns true for EU inference profiles", () => {
			expect(isInferenceProfile("eu.amazon.nova-pro-v1:0")).toBe(true);
		});

		it("returns true for APAC inference profiles", () => {
			expect(isInferenceProfile("apac.meta.llama-3-70b-v1:0")).toBe(true);
		});

		it("returns true for global inference profiles", () => {
			expect(isInferenceProfile("global.anthropic.claude-sonnet-4-v1:0")).toBe(
				true,
			);
		});

		it("returns false for regular model IDs", () => {
			expect(isInferenceProfile("anthropic.claude-3-sonnet-v1")).toBe(false);
			expect(isInferenceProfile("writer.palmyra-x5-v1:0")).toBe(false);
		});
	});

	describe("getBedrockStatus", () => {
		it("returns status with environment credentials", () => {
			process.env.AWS_ACCESS_KEY_ID = "test-key";
			process.env.AWS_REGION = "us-west-2";

			const status = getBedrockStatus();
			expect(status.hasCredentials).toBe(true);
			expect(status.region).toBe("us-west-2");
			expect(status.credentialSources).toContain("environment");
		});

		it("returns status with profile credentials", () => {
			process.env.AWS_PROFILE = "my-profile";

			const status = getBedrockStatus();
			expect(status.hasCredentials).toBe(true);
			expect(status.credentialSources).toContain("profile:my-profile");
		});

		it("returns empty sources when no credentials", () => {
			const status = getBedrockStatus();
			expect(status.hasCredentials).toBe(false);
			expect(status.credentialSources).toHaveLength(0);
		});
	});
});
