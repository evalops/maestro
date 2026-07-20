import type { Container, TUI } from "@evalops/tui";
import type { FooterComponent } from "../footer.js";
import { LoaderView } from "../loader/loader-view.js";

export interface LoaderViewOptions {
	ui: TUI;
	statusContainer: Container;
	footer: FooterComponent;
	lowColor: boolean;
	lowUnicode: boolean;
	disableAnimations: boolean;
	onLayoutChange: () => void;
}

export function createLoaderView(options: LoaderViewOptions): LoaderView {
	return new LoaderView({
		ui: options.ui,
		statusContainer: options.statusContainer,
		footer: options.footer,
		lowColor: options.lowColor,
		lowUnicode: options.lowUnicode,
		disableAnimations: options.disableAnimations,
		onLayoutChange: options.onLayoutChange,
	});
}
