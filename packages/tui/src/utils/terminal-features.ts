/**
 * Heuristics for SSH / constrained terminals.
 * We avoid enabling features that break on minimal TERM values.
 */
export interface TerminalFeatures {
	supportsBracketedPaste: boolean;
	supportsSyncOutput: boolean;
	supportsAltScreen: boolean;
	lowColor: boolean;
	lowUnicode: boolean;
	overSsh: boolean;
}

const LOW_COLOR_TERMS = ["dumb", "linux", "vt100", "vt220", "ansi"];

export function detectTerminalFeatures(env = process.env): TerminalFeatures {
	const term = (env.TERM || "").toLowerCase();
	const colorterm = (env.COLORTERM || "").toLowerCase();
	const ssh = Boolean(env.SSH_CONNECTION || env.SSH_CLIENT);
	const tmux = Boolean(env.TMUX || env.STY);

	const forceLowColor = LOW_COLOR_TERMS.includes(term);
	const lowColor = forceLowColor || colorterm === "";

	const lowUnicode = forceLowColor;

	// Sync output (DECSET 2026) is great locally but causes "typed in waves"
	// over SSH/tmux when the host PTY buffers frames. Disable by default for SSH
	// and allow explicit env overrides:
	//   COMPOSER_NO_SYNC=1          -> force off
	//   COMPOSER_SYNC_OUTPUT=0|false -> force off
	//   COMPOSER_SYNC_OUTPUT=1|true  -> force on (even over SSH)
	const syncOverrideRaw = env.COMPOSER_SYNC_OUTPUT
		? env.COMPOSER_SYNC_OUTPUT.toLowerCase()
		: undefined;
	const syncForcedOff =
		env.COMPOSER_NO_SYNC === "1" ||
		syncOverrideRaw === "0" ||
		syncOverrideRaw === "false";
	const syncForcedOn = syncOverrideRaw === "1" || syncOverrideRaw === "true";

	let supportsSyncOutput = !term.includes("dumb") && !term.includes("linux");
	if (ssh || tmux) {
		supportsSyncOutput = false;
	}
	if (syncForcedOn) supportsSyncOutput = true;
	if (syncForcedOff) supportsSyncOutput = false;

	return {
		supportsBracketedPaste: !term.includes("dumb"),
		supportsSyncOutput,
		supportsAltScreen: !term.includes("dumb"),
		lowColor: forceLowColor,
		lowUnicode,
		overSsh: ssh,
	};
}
