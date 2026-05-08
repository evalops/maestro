export const DEFAULT_PROMPT_SAFE_TEXT_MAX_LENGTH = 1024;

/**
 * Normalize externally-authored metadata before including it in prompts or
 * model-facing tool output.
 */
export function promptSafeText(
	value: string | null | undefined,
	maxLength = DEFAULT_PROMPT_SAFE_TEXT_MAX_LENGTH,
): string | null {
	if (!value || maxLength <= 0) {
		return null;
	}

	let output = "";
	let emitted = 0;
	let whitespaceRun = 0;
	let pendingSpace = false;
	let hasText = false;

	for (const char of value) {
		if (/\s/u.test(char)) {
			if (whitespaceRun >= maxLength) {
				break;
			}
			whitespaceRun += 1;
			if (hasText) {
				pendingSpace = true;
			}
			continue;
		}

		whitespaceRun = 0;
		if (pendingSpace && emitted > 0) {
			if (emitted + 1 >= maxLength) {
				break;
			}
			output += " ";
			emitted += 1;
			pendingSpace = false;
		}

		if (emitted >= maxLength) {
			break;
		}
		output += char;
		emitted += 1;
		hasText = true;
	}

	return output || null;
}
