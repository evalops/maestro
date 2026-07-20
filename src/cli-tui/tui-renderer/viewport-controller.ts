import type { Container, ScrollContainer } from "@evalops/tui";
import type { FooterComponent } from "../footer.js";

export interface ViewportControllerDeps {
	headerContainer: Container;
	startupContainer: Container;
	statusContainer: Container;
	editorContainer: Container;
	footer: FooterComponent;
	scrollContainer: ScrollContainer;
	getColumns: () => number;
	getRows: () => number;
}

export interface ViewportControllerOptions {
	deps: ViewportControllerDeps;
}

export class ViewportController {
	private readonly deps: ViewportControllerDeps;
	private readonly layout = {
		columns: 0,
		header: 0,
		startup: 0,
		status: 0,
		editor: 0,
		footer: 0,
	};
	private readonly dirty = {
		header: true,
		startup: true,
		status: true,
		editor: true,
		footer: true,
	};
	private appliedChatViewportHeight = 0;

	constructor(options: ViewportControllerOptions) {
		this.deps = options.deps;
	}

	markHeaderDirty(): void {
		this.dirty.header = true;
	}

	markStartupDirty(): void {
		this.dirty.startup = true;
	}

	markStatusDirty(): void {
		this.dirty.status = true;
	}

	markEditorDirty(): void {
		this.dirty.editor = true;
	}

	markFooterDirty(): void {
		this.dirty.footer = true;
	}

	markAllDirty(): void {
		this.dirty.header = true;
		this.dirty.startup = true;
		this.dirty.status = true;
		this.dirty.editor = true;
		this.dirty.footer = true;
	}

	updateScrollViewport(options: { fast?: boolean } = {}): void {
		const rows = this.deps.getRows();
		const columns = this.deps.getColumns();

		if (columns !== this.layout.columns) {
			this.layout.columns = columns;
			this.markAllDirty();
		}

		const shouldMeasureAll =
			!options.fast ||
			this.dirty.header ||
			this.dirty.startup ||
			this.dirty.status ||
			this.dirty.footer;

		if (shouldMeasureAll) {
			if (this.dirty.header) {
				this.layout.header = this.deps.headerContainer.render(columns).length;
				this.dirty.header = false;
			}
			if (this.dirty.startup) {
				this.layout.startup = this.deps.startupContainer.render(columns).length;
				this.dirty.startup = false;
			}
			if (this.dirty.status) {
				this.layout.status = this.deps.statusContainer.render(columns).length;
				this.dirty.status = false;
			}
			if (this.dirty.editor) {
				this.layout.editor = this.deps.editorContainer.render(columns).length;
				this.dirty.editor = false;
			}
			if (this.dirty.footer) {
				this.layout.footer = this.deps.footer.render(columns).length;
				this.dirty.footer = false;
			}
		} else if (this.dirty.editor) {
			this.layout.editor = this.deps.editorContainer.render(columns).length;
			this.dirty.editor = false;
		}

		const reserved =
			this.layout.header +
			this.layout.startup +
			this.layout.status +
			1 +
			this.layout.editor +
			this.layout.footer;

		const available = Math.max(1, rows - reserved);
		if (available === this.appliedChatViewportHeight) {
			return;
		}
		this.deps.scrollContainer.setViewportHeight(available);
		this.appliedChatViewportHeight = available;
	}
}

export function createViewportController(
	options: ViewportControllerOptions,
): ViewportController {
	return new ViewportController(options);
}
