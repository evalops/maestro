/**
 * Lightweight shared data store so components can share status/models/usage
 * without duplicate network calls.
 */

import type {
	ApiClient,
	Model,
	UsageSummary,
	WorkspaceStatus,
} from "./api-client.js";

type StoreSnapshot = {
	status: WorkspaceStatus | null;
	models: Model[];
	usage: UsageSummary | null;
	lastError: string | null;
	lastUpdated: number | null;
	lastLatencyMs: number | null;
};

type Listener = (snapshot: StoreSnapshot) => void;

class DataStore {
	private snapshot: StoreSnapshot = {
		status: null,
		models: [],
		usage: null,
		lastError: null,
		lastUpdated: null,
		lastLatencyMs: null,
	};

	private listeners = new Set<Listener>();
	private modelsLoading = false;
	private statusLoading = false;
	private usageLoading = false;

	subscribe(listener: Listener) {
		this.listeners.add(listener);
		listener(this.snapshot);
		return () => this.listeners.delete(listener);
	}

	private notify() {
		for (const listener of this.listeners) {
			listener(this.snapshot);
		}
	}

	getSnapshot(): StoreSnapshot {
		return this.snapshot;
	}

	async ensureStatus(apiClient: ApiClient, force = false) {
		if (this.statusLoading) return;
		if (this.snapshot.status && !force) return;
		this.statusLoading = true;
		try {
			const started = performance.now();
			const status = await apiClient.getStatus();
			const latency = performance.now() - started;
			if (status) {
				const enriched = {
					...status,
					lastUpdated: Date.now(),
					lastLatencyMs: latency,
				};
				try {
					localStorage.setItem(
						"composer_status_cache",
						JSON.stringify(enriched),
					);
				} catch {
					/* ignore storage failures */
				}
				this.snapshot = {
					...this.snapshot,
					status: enriched,
					lastError: null,
					lastUpdated: Date.now(),
					lastLatencyMs: latency,
				};
			} else {
				this.snapshot = {
					...this.snapshot,
					status,
					lastError: null,
					lastUpdated: Date.now(),
					lastLatencyMs: latency,
				};
			}
		} catch (e) {
			this.snapshot = {
				...this.snapshot,
				lastError: e instanceof Error ? e.message : "Failed to load status",
			};
		} finally {
			this.statusLoading = false;
			this.notify();
		}
	}

	async ensureModels(apiClient: ApiClient, force = false) {
		if (this.modelsLoading) return;
		if (this.snapshot.models.length > 0 && !force) return;
		this.modelsLoading = true;
		try {
			const models = await apiClient.getModels();
			if (models && models.length > 0) {
				try {
					localStorage.setItem("composer_models_cache", JSON.stringify(models));
				} catch {
					/* ignore storage failures */
				}
			}
			this.snapshot = {
				...this.snapshot,
				models,
				lastError: null,
				lastUpdated: Date.now(),
			};
		} catch (e) {
			this.snapshot = {
				...this.snapshot,
				lastError: e instanceof Error ? e.message : "Failed to load models",
			};
		} finally {
			this.modelsLoading = false;
			this.notify();
		}
	}

	async ensureUsage(apiClient: ApiClient, force = false) {
		if (this.usageLoading) return;
		if (this.snapshot.usage && !force) return;
		this.usageLoading = true;
		try {
			const usage = await apiClient.getUsage();
			if (usage) {
				try {
					localStorage.setItem("composer_usage_cache", JSON.stringify(usage));
				} catch {
					/* ignore storage failures */
				}
			}
			this.snapshot = {
				...this.snapshot,
				usage,
				lastError: null,
				lastUpdated: Date.now(),
			};
		} catch (e) {
			this.snapshot = {
				...this.snapshot,
				lastError: e instanceof Error ? e.message : "Failed to load usage",
			};
		} finally {
			this.usageLoading = false;
			this.notify();
		}
	}
}

export const dataStore = new DataStore();
