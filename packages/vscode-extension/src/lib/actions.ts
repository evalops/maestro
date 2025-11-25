const DEFAULT_BASE_URL = "https://composer.evalops.ai";

export type ComposerAction = "web" | "docs" | "tui";

const ACTION_PATHS: Record<ComposerAction, string> = {
	web: "/",
	docs: "/docs",
	tui: "/docs/tui",
};

export function buildComposerUrl(action: ComposerAction = "web"): string {
	const base = new URL(DEFAULT_BASE_URL);
	base.pathname = ACTION_PATHS[action] ?? "/";
	return base.toString();
}

export function getActionLabel(action: ComposerAction): string {
	switch (action) {
		case "docs":
			return "View Documentation";
		case "tui":
			return "Launch Terminal UI";
		default:
			return "Open Composer";
	}
}
