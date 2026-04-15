import type { PromptRecoveryCallbacks } from "../agent/prompt-recovery.js";

export interface TuiCompactionStateRestorer {
	restoreActiveSkillsAfterCompaction?: () => unknown;
}

export function withTuiCompactionRestoration(
	callbacks: PromptRecoveryCallbacks | undefined,
	restorer?: TuiCompactionStateRestorer,
): PromptRecoveryCallbacks | undefined {
	if (!restorer?.restoreActiveSkillsAfterCompaction) {
		return callbacks;
	}

	return {
		...callbacks,
		onCompacted: (result) => {
			restorer.restoreActiveSkillsAfterCompaction?.();
			callbacks?.onCompacted?.(result);
		},
	};
}
