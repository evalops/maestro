/**
 * Password hashing and validation using bcrypt
 */

import bcrypt from "bcrypt";

const SALT_ROUNDS = 12;

/**
 * Hash a password using bcrypt
 */
export async function hashPassword(password: string): Promise<string> {
	return await bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify a password against a hash
 */
export async function verifyPassword(
	password: string,
	hash: string,
): Promise<boolean> {
	return await bcrypt.compare(password, hash);
}

/**
 * Validate password strength
 */
export function validatePasswordStrength(password: string): {
	valid: boolean;
	errors: string[];
} {
	const errors: string[] = [];

	if (password.length < 8) {
		errors.push("Password must be at least 8 characters long");
	}

	if (!/[a-z]/.test(password)) {
		errors.push("Password must contain at least one lowercase letter");
	}

	if (!/[A-Z]/.test(password)) {
		errors.push("Password must contain at least one uppercase letter");
	}

	if (!/[0-9]/.test(password)) {
		errors.push("Password must contain at least one number");
	}

	if (!/[^a-zA-Z0-9]/.test(password)) {
		errors.push("Password must contain at least one special character");
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}
