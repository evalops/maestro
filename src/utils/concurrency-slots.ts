/**
 * @deprecated Use `src/utils/concurrency-manager.ts`.
 *
 * Kept as a compatibility shim for older internal imports.
 */
export {
	ConcurrencyManager as ConcurrencySlots,
	createConcurrencyManagerFromEnv as createConcurrencySlotsFromEnv,
	type ConcurrencySnapshot,
} from "./concurrency-manager.js";
