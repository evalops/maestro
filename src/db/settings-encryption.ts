/**
 * Transparent encryption for sensitive fields in JSONB settings columns.
 *
 * Provides helpers to encrypt/decrypt specific sensitive fields within
 * OrganizationSettings and UserSettings while leaving other fields unchanged.
 */

import {
	decryptField,
	encryptField,
	isEncrypted,
	isEncryptionEnabled,
} from "./encryption.js";
import type { OrganizationSettings, UserSettings } from "./schema.js";

// ============================================================================
// ORGANIZATION SETTINGS
// ============================================================================

/**
 * Encrypt sensitive fields in organization settings before storing in DB.
 * Currently encrypts: webhookSigningSecret
 */
export function encryptOrgSettings(
	settings: OrganizationSettings | null | undefined,
): OrganizationSettings | null | undefined {
	if (!settings || !isEncryptionEnabled()) {
		return settings;
	}

	const result = { ...settings };

	if (result.webhookSigningSecret) {
		result.webhookSigningSecret = encryptField(result.webhookSigningSecret);
	}

	return result;
}

/**
 * Decrypt sensitive fields in organization settings after reading from DB.
 * Currently decrypts: webhookSigningSecret
 */
export function decryptOrgSettings(
	settings: OrganizationSettings | null | undefined,
): OrganizationSettings | null | undefined {
	if (!settings) {
		return settings;
	}

	const result = { ...settings };

	if (result.webhookSigningSecret && isEncrypted(result.webhookSigningSecret)) {
		result.webhookSigningSecret = decryptField(result.webhookSigningSecret);
	}

	return result;
}

// ============================================================================
// USER SETTINGS
// ============================================================================

/**
 * Encrypt sensitive fields in user settings before storing in DB.
 * Currently encrypts: twoFactor.secret (TOTP secret)
 */
export function encryptUserSettings(
	settings: UserSettings | null | undefined,
): UserSettings | null | undefined {
	if (!settings || !isEncryptionEnabled()) {
		return settings;
	}

	const result = { ...settings };

	if (result.twoFactor?.secret) {
		result.twoFactor = {
			...result.twoFactor,
			secret: encryptField(result.twoFactor.secret),
		};
	}

	return result;
}

/**
 * Decrypt sensitive fields in user settings after reading from DB.
 * Currently decrypts: twoFactor.secret (TOTP secret)
 */
export function decryptUserSettings(
	settings: UserSettings | null | undefined,
): UserSettings | null | undefined {
	if (!settings) {
		return settings;
	}

	const result = { ...settings };

	if (result.twoFactor?.secret && isEncrypted(result.twoFactor.secret)) {
		result.twoFactor = {
			...result.twoFactor,
			secret: decryptField(result.twoFactor.secret),
		};
	}

	return result;
}

// ============================================================================
// ENCRYPTION STATUS HELPERS
// ============================================================================

/**
 * Check if an organization's webhook signing secret is encrypted.
 */
export function isOrgSecretEncrypted(
	settings: OrganizationSettings | null | undefined,
): boolean {
	if (!settings?.webhookSigningSecret) {
		return false;
	}
	return isEncrypted(settings.webhookSigningSecret);
}

/**
 * Check if a user's TOTP secret is encrypted.
 */
export function isUserTotpSecretEncrypted(
	settings: UserSettings | null | undefined,
): boolean {
	if (!settings?.twoFactor?.secret) {
		return false;
	}
	return isEncrypted(settings.twoFactor.secret);
}
