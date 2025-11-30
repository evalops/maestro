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

	const forceLowColor = LOW_COLOR_TERMS.includes(term);
	const lowColor = forceLowColor || colorterm === "";

	const lowUnicode = forceLowColor;

	return {
		supportsBracketedPaste: !term.includes("dumb"),
		supportsSyncOutput: !term.includes("dumb") && !term.includes("linux"),
		supportsAltScreen: !term.includes("dumb"),
		lowColor: forceLowColor,
		lowUnicode,
		overSsh: ssh,
	};
}
