export interface ToolRenderArgs {
	toolName: string;
	args: Record<string, unknown>;
	partialArgs?: Record<string, unknown>;
	result?: {
		content?:
			| Array<{
					type: string;
					text?: string;
					data?: string;
					mimeType?: string;
			  }>
			| string;
		isError: boolean;
		details?: unknown;
	};
	collapsed: boolean;
}

export interface ToolRenderer {
	render(context: ToolRenderArgs): string;
}
