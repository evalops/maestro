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
