/**
 * Secret Redactor - Sensitive Data Masking
 *
 * This module provides utilities for detecting and redacting sensitive
 * information from text. It uses pattern matching to identify common
 * secret formats and replaces them with masked values.
 *
 * ## Detected Secret Types
 *
 * | Pattern              | Example                              |
 * |----------------------|--------------------------------------|
 * | OpenAI/Anthropic keys| sk-abc123...                         |
 * | AWS Access Keys      | AKIA..., ASIA...                     |
 * | GitHub Tokens        | ghp_..., gho_..., ghs_..., ghr_...   |
 * | JWT Tokens           | eyJ...header.payload.signature       |
 * | Bearer Tokens        | Bearer abc123...                     |
 * | Basic Auth           | Basic base64encoded...               |
 * | Keyword secrets      | password=..., token:...              |
 * | Slack/Google tokens  | xoxb-..., AIza..., ya29...           |
 * | Long hex strings     | 64+ character hex strings            |
 *
 * ## Usage
 *
 * ```typescript
 * import { redactSecrets, createMasker } from './secret-redactor';
 *
 * const masker = createMasker('[REDACTED]');
 * const safe = redactSecrets(
 *   'API key: sk-abc123456789',
 *   masker
 * );
 * // Result: 'API key: [REDACTED]'
 * ```
 *
 * ## Masking Strategies
 *
 * - `createMasker(placeholder)`: Replace with fixed placeholder
 * - Custom function: Receive original secret, return masked value
 *
 * @module utils/secret-redactor
 */

import { replaceCredentialPatternMatches } from "../safety/credential-patterns.js";

const DYNAMIC_PLACEHOLDER_REGEX = /\[secret:[^\]]+\]/g;

export type SecretMasker = (secret: string) => string;

export function redactSecrets(value: string, maskSecret: SecretMasker): string {
	if (!value) {
		return value;
	}
	return replaceCredentialPatternMatches(value, (secret) => maskSecret(secret));
}

function normalizeDynamicPlaceholders(value: string): string {
	if (!value) {
		return value;
	}
	return value.replace(DYNAMIC_PLACEHOLDER_REGEX, "[secret]");
}

export function sanitizeWithStaticMask(value: string): string {
	const normalized = normalizeDynamicPlaceholders(value);
	return redactSecrets(normalized, () => "[secret]");
}

export function sanitizeOptionalWithStaticMask(
	value?: string | null,
): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	return sanitizeWithStaticMask(value);
}
