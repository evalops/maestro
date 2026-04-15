/**
 * Lightweight cache helpers for safety rule evaluation.
 * Keeps caches co-located instead of scattering WeakMaps in consumers.
 */

export class RuleCache<K extends object, V> {
	private readonly store = new WeakMap<K, V>();

	set(key: K, value: V): void {
		this.store.set(key, value);
	}

	get(key: K): V | undefined {
		return this.store.get(key);
	}
}
