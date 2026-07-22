/**
 * No-op automatic memory coordinators.
 *
 * Used when native memory is disabled (`MAESTRO_NATIVE_MEMORY=0`) or when a
 * surface needs coordinator slots without scheduling work. Real native
 * extraction/consolidation lives in `src/server/native-memory.ts` (default ON
 * for native paths via `runNativeBackgroundPrompt`).
 *
 * @module server/native-memory-noop
 */

import type { AutomaticMemoryConsolidationCoordinator } from "../memory/auto-consolidation.js";
import type { AutomaticMemoryExtractionCoordinator } from "../memory/auto-extraction.js";

/** Shared no-op extraction coordinator (schedule/flush are intentional no-ops). */
export const noopAutomaticMemoryExtraction: AutomaticMemoryExtractionCoordinator =
	{
		schedule: (_sessionPath?: string | null) => {},
		flush: async () => {},
	};

/** Shared no-op consolidation coordinator (schedule/flush are intentional no-ops). */
export const noopAutomaticMemoryConsolidation: AutomaticMemoryConsolidationCoordinator =
	{
		schedule: () => {},
		flush: async () => {},
	};

/**
 * Pair of no-op coordinators for native headless / chat surfaces that need both
 * extraction and consolidation slots filled without spawning background work.
 */
export function createNativeMemoryNoopCoordinators(): {
	extraction: AutomaticMemoryExtractionCoordinator;
	consolidation: AutomaticMemoryConsolidationCoordinator;
} {
	return {
		extraction: noopAutomaticMemoryExtraction,
		consolidation: noopAutomaticMemoryConsolidation,
	};
}
