/**
 * Credential Manager - Stores and retrieves connector credentials using StorageBackend.
 *
 * Keys are stored as `connector:creds:<name>` in the storage backend.
 * Secrets are never logged.
 */

import type { StorageBackend } from "../storage.js";
import type { ConnectorCredentials } from "./types.js";

const KEY_PREFIX = "connector:creds:";

export class CredentialManager {
	constructor(private storage: StorageBackend) {}

	async get(name: string): Promise<ConnectorCredentials | null> {
		return this.storage.get<ConnectorCredentials>(`${KEY_PREFIX}${name}`);
	}

	async set(name: string, credentials: ConnectorCredentials): Promise<void> {
		await this.storage.set(`${KEY_PREFIX}${name}`, credentials);
	}

	async delete(name: string): Promise<boolean> {
		return this.storage.delete(`${KEY_PREFIX}${name}`);
	}

	async exists(name: string): Promise<boolean> {
		return this.storage.exists(`${KEY_PREFIX}${name}`);
	}

	async list(): Promise<string[]> {
		const keys = await this.storage.keys(`${KEY_PREFIX}*`);
		return keys.map((k) => k.slice(KEY_PREFIX.length));
	}
}

/**
 * Create a getCredentials callback for the connector registry
 * using a CredentialManager instance.
 */
export function createCredentialGetter(
	manager: CredentialManager,
): (name: string) => Promise<ConnectorCredentials | null> {
	return (name: string) => manager.get(name);
}
