export interface ToolRenderArgs {
	toolName: string;
	args: any;
	partialArgs?: any;
	result?: {
		content: Array<{
			type: string;
			text?: string;
			data?: string;
			mimeType?: string;
		}>;
		isError: boolean;
		details?: any;
	};
	collapsed: boolean;
}

export interface ToolRenderer {
	render(context: ToolRenderArgs): string;
}
