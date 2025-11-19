import type { TUI } from "@evalops/tui";
import type { FooterComponent } from "./footer.js";
import type { LoaderView } from "./loader-view.js";

interface RunControllerOptions {
	loaderView: LoaderView;
	footer: FooterComponent;
	ui: TUI;
	workingHint: string;
	setEditorDisabled: (disabled: boolean) => void;
	clearEditor: () => void;
	stopRenderer: () => void;
	refreshFooterHint: () => void;
	notifyFileChanges: () => void;
}

export class RunController {
	private lastCtrlCTime = 0;

	constructor(private readonly options: RunControllerOptions) {}

	handleAgentStart(): void {
		this.options.setEditorDisabled(true);
		this.options.loaderView.start();
		this.options.footer.setHint(this.options.workingHint);
		this.options.ui.requestRender();
	}

	handleAgentEnd(afterCleanup: () => void): void {
		this.options.loaderView.finish();
		afterCleanup();
		this.options.setEditorDisabled(false);
		this.options.notifyFileChanges();
		this.options.refreshFooterHint();
		this.options.ui.requestRender();
	}

	handleCtrlC(): void {
		const now = Date.now();
		if (now - this.lastCtrlCTime < 500) {
			this.options.stopRenderer();
			process.exit(0);
		}
		this.options.clearEditor();
		this.lastCtrlCTime = now;
	}
}
