/**
 * AWS Authentication Helpers for Bedrock
 *
 * This module provides helper functions for AWS credential detection and
 * region configuration. The actual authentication is handled by the
 * AWS SDK's default credential provider chain.
 *
 * @module providers/aws-auth
 */

/**
 * Check if AWS credentials are likely available via the SDK's default provider chain.
 *
 * The SDK automatically resolves credentials in this order:
 * 1. Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
 * 2. SSO credentials (AWS_SSO_* / sso-session in config)
 * 3. INI files (~/.aws/credentials, ~/.aws/config) via AWS_PROFILE
 * 4. Credential process (credential_process in config)
 * 5. Web identity token (AWS_WEB_IDENTITY_TOKEN_FILE for EKS)
 * 6. Instance/container metadata (EC2 IMDS, ECS task role)
 *
 * This check is a heuristic - actual credential resolution happens at runtime.
 * We check for env vars that indicate credentials are likely available.
 *
 * Note: We cannot detect EC2/ECS metadata credentials without making network calls,
 * so those will only be discovered at runtime when the SDK tries to use them.
 */
export function hasAwsCredentials(): boolean {
	return !!(
		// Environment credentials
		(
			process.env.AWS_ACCESS_KEY_ID ||
			// Profile-based credentials (INI files or SSO)
			process.env.AWS_PROFILE ||
			// SSO session
			process.env.AWS_SSO_SESSION_NAME ||
			// Web identity token (EKS IRSA)
			process.env.AWS_WEB_IDENTITY_TOKEN_FILE ||
			// Container credentials (ECS task role)
			process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
			process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI
		)
	);
}

/**
 * Get the AWS region for Bedrock
 */
export function getAwsRegion(): string {
	return (
		process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1"
	);
}

/**
 * Build Bedrock runtime URL for a model (used for display/logging only)
 */
export function buildBedrockUrl(
	region: string,
	modelId: string,
	streaming = true,
): string {
	const endpoint = streaming ? "converse-stream" : "converse";
	return `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/${endpoint}`;
}

/**
 * Parsed Bedrock ARN information
 */
export interface BedrockArnInfo {
	/** AWS region from the ARN */
	region: string;
	/** AWS account ID (empty for foundation models) */
	accountId: string;
	/** Resource type: foundation-model, inference-profile, provisioned-model */
	resourceType: string;
	/** Resource ID (model ID or profile ID) */
	resourceId: string;
}

/**
 * Parse a Bedrock ARN or inference profile ID to extract region and resource info.
 *
 * Supports:
 * - Foundation model ARNs: arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-3-sonnet-v1
 * - Inference profile ARNs: arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-3-5-sonnet-v2
 * - Provisioned model ARNs: arn:aws:bedrock:us-east-1:123456789012:provisioned-model/abc123
 * - Inference profile IDs: us.anthropic.claude-3-5-sonnet-20241022-v2:0 (no region extraction)
 *
 * @param arnOrId - ARN string or model/profile ID
 * @returns Parsed ARN info or null if not an ARN
 */
export function parseBedrockArn(arnOrId: string): BedrockArnInfo | null {
	// ARN format: arn:aws:bedrock:region:account-id:resource-type/resource-id
	const arnMatch = arnOrId.match(
		/^arn:aws:bedrock:([a-z0-9-]+):([0-9]*):([a-z-]+)\/(.+)$/,
	);

	if (arnMatch) {
		return {
			region: arnMatch[1]!,
			accountId: arnMatch[2]!,
			resourceType: arnMatch[3]!,
			resourceId: arnMatch[4]!,
		};
	}

	return null;
}

/**
 * Check if a model ID is a cross-region inference profile.
 *
 * Cross-region inference profiles follow the pattern:
 * - us.anthropic.claude-3-5-sonnet-v2:0 (US)
 * - eu.amazon.nova-pro-v1:0 (EU)
 * - apac.meta.llama-3-70b-v1:0 (APAC)
 * - global.anthropic.claude-sonnet-4-v1:0 (Global)
 */
export function isInferenceProfile(modelId: string): boolean {
	return /^(us|eu|apac|global)\.[a-z0-9.-]+/.test(modelId);
}

/**
 * Get Bedrock status information for diagnostics
 */
export function getBedrockStatus(): {
	hasCredentials: boolean;
	region: string;
	credentialSources: string[];
} {
	const credentialSources: string[] = [];

	if (process.env.AWS_ACCESS_KEY_ID) {
		credentialSources.push("environment");
	}
	if (process.env.AWS_PROFILE) {
		credentialSources.push(`profile:${process.env.AWS_PROFILE}`);
	}
	if (process.env.AWS_SSO_SESSION_NAME) {
		credentialSources.push(`sso:${process.env.AWS_SSO_SESSION_NAME}`);
	}
	if (process.env.AWS_WEB_IDENTITY_TOKEN_FILE) {
		credentialSources.push("web-identity");
	}
	if (process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) {
		credentialSources.push("ecs-container");
	}
	if (process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI) {
		credentialSources.push("container-full-uri");
	}

	return {
		hasCredentials: hasAwsCredentials(),
		region: getAwsRegion(),
		credentialSources,
	};
}
