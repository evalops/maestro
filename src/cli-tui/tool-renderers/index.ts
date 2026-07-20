import { BashRenderer } from "./render-bash.js";
import { BatchRenderer } from "./render-batch.js";
import { EditRenderer } from "./render-edit.js";
import { GenericRenderer } from "./render-generic.js";
import { ReadRenderer } from "./render-read.js";
import { WriteRenderer } from "./render-write.js";
import type { ToolRenderer } from "./types.js";

const RENDERERS: Record<string, new () => ToolRenderer> = {
	batch: BatchRenderer,
	bash: BashRenderer,
	read: ReadRenderer,
	write: WriteRenderer,
	edit: EditRenderer,
};

export type { ToolRenderer, ToolRenderArgs } from "./types.js";

export function createToolRenderer(toolName: string): ToolRenderer {
	const key = toolName.toLowerCase();
	const RendererClass = RENDERERS[key] ?? GenericRenderer;
	return new RendererClass();
}
