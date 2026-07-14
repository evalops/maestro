import type { AgentTool } from "../agent/types.js";

const lazyToolLoaders = {
	read: async () => (await import("./read.js")).readTool,
	list: async () => (await import("./list.js")).listTool,
	oracle: async () => (await import("./oracle.js")).oracleTool,
	painter: async () => (await import("./painter.js")).painterTool,
	find: async () => (await import("./find.js")).findTool,
	extract_document: async () =>
		(await import("./extract-document.js")).extractDocumentTool,
	search: async () => (await import("./search.js")).searchTool,
	parallel_ripgrep: async () =>
		(await import("./parallel-ripgrep.js")).parallelRipgrepTool,
	diff: async () => (await import("./diff.js")).diffTool,
	bash: async () => (await import("./bash.js")).bashTool,
	background_tasks: async () =>
		(await import("./background/tool-handler.js")).backgroundTasksTool,
	apply_patch: async () => (await import("./apply-patch.js")).applyPatchTool,
	edit: async () => (await import("./edit.js")).editTool,
	write: async () => (await import("./write.js")).writeTool,
	notebook_edit: async () => (await import("./notebook.js")).notebookEditTool,
	todo: async () => (await import("./todo.js")).todoTool,
	ask_user: async () => (await import("./ask-user.js")).askUserTool,
	websearch: async () => (await import("./websearch.js")).websearchTool,
	codesearch: async () => (await import("./codesearch.js")).codesearchTool,
	webfetch: async () => (await import("./webfetch.js")).webfetchTool,
	status: async () => (await import("./status.js")).statusTool,
	gh_pr: async () => (await import("./gh.js")).ghPrTool,
	gh_issue: async () => (await import("./gh.js")).ghIssueTool,
	gh_repo: async () => (await import("./gh.js")).ghRepoTool,
	pipeline_search_contacts: async () =>
		(await import("./pipeline.js")).pipelineSearchContactsTool,
	pipeline_search_deals: async () =>
		(await import("./pipeline.js")).pipelineSearchDealsTool,
	pipeline_create_signal: async () =>
		(await import("./pipeline.js")).pipelineCreateSignalTool,
	pipeline_log_activity: async () =>
		(await import("./pipeline.js")).pipelineLogActivityTool,
} satisfies Record<string, () => Promise<AgentTool>>;

export const lazyToolNames = Object.keys(lazyToolLoaders).sort();

export async function loadFilteredTools(
	toolNames: string[],
): Promise<AgentTool[]> {
	const filtered: AgentTool[] = [];
	for (const name of toolNames) {
		const loadTool = lazyToolLoaders[name as keyof typeof lazyToolLoaders];
		if (loadTool) {
			filtered.push(await loadTool());
		}
	}
	return filtered;
}
