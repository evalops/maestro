/**
 * AWS Authentication - SigV4 Request Signing for Bedrock
 *
 * This module provides AWS Signature Version 4 signing for HTTP requests
 * to AWS Bedrock. It supports multiple credential sources:
 *
 * 1. Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
 * 2. AWS profiles (~/.aws/credentials)
 * 3. Bearer token authentication (AWS_BEARER_TOKEN_BEDROCK)
 *
 * @module providers/aws-auth
 */

import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("providers:aws-auth");

export interface AwsCredentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}

export interface AwsAuthConfig {
	region: string;
	service: string;
	credentials?: AwsCredentials;
	bearerToken?: string;
}

/**
 * Resolve AWS credentials from environment or profile
 */
export function resolveAwsCredentials(): AwsCredentials | null {
	const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
	const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
	const sessionToken = process.env.AWS_SESSION_TOKEN;

	if (accessKeyId && secretAccessKey) {
		return {
			accessKeyId,
			secretAccessKey,
			sessionToken,
		};
	}

	// Could extend to read from ~/.aws/credentials using AWS_PROFILE
	// For now, we rely on environment variables
	return null;
}

/**
 * Check if AWS credentials are available
 */
export function hasAwsCredentials(): boolean {
	return !!(
		process.env.AWS_ACCESS_KEY_ID ||
		process.env.AWS_PROFILE ||
		process.env.AWS_BEARER_TOKEN_BEDROCK
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
 * Sign an HTTP request using AWS Signature Version 4
 */
export async function signAwsRequest(
	request: {
		method: string;
		url: string;
		headers: Record<string, string>;
		body?: string;
	},
	config: AwsAuthConfig,
): Promise<Record<string, string>> {
	// If bearer token is provided, use that instead of SigV4
	if (config.bearerToken) {
		return {
			...request.headers,
			Authorization: `Bearer ${config.bearerToken}`,
		};
	}

	const credentials = config.credentials ?? resolveAwsCredentials();
	if (!credentials) {
		throw new Error(
			"AWS credentials not found. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, " +
				"or use AWS_BEARER_TOKEN_BEDROCK for bearer token authentication.",
		);
	}

	const url = new URL(request.url);

	// Create the HTTP request object for signing
	const httpRequest = new HttpRequest({
		method: request.method,
		protocol: url.protocol,
		hostname: url.hostname,
		port: url.port ? Number.parseInt(url.port, 10) : undefined,
		path: url.pathname + url.search,
		headers: {
			...request.headers,
			host: url.host,
		},
		body: request.body,
	});

	// Create the signer
	const signer = new SignatureV4({
		credentials,
		region: config.region,
		service: config.service,
		sha256: Sha256,
	});

	// Sign the request
	const signedRequest = await signer.sign(httpRequest);

	// Extract signed headers
	const signedHeaders: Record<string, string> = {};
	const headers = signedRequest.headers as Record<
		string,
		string | string[] | undefined
	>;
	for (const [key, value] of Object.entries(headers)) {
		if (typeof value === "string") {
			signedHeaders[key] = value;
		} else if (Array.isArray(value)) {
			signedHeaders[key] = value.join(", ");
		}
	}

	return signedHeaders;
}

/**
 * Build Bedrock runtime URL for a model
 */
export function buildBedrockUrl(
	region: string,
	modelId: string,
	streaming = true,
): string {
	const endpoint = streaming ? "converse-stream" : "converse";
	return `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/${endpoint}`;
}
