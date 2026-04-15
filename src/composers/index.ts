export {
	loadComposers,
	getComposerByName,
	getComposerDirs,
} from "./loader.js";
export { ComposerManager, composerManager } from "./manager.js";
export {
	getBuiltinAgents,
	getBuiltinAgent,
	BUILTIN_AGENTS,
} from "./builtin.js";
export type {
	ComposerConfig,
	ComposerState,
	ComposerTrigger,
	LoadedComposer,
	PermissionLevel,
	ToolPermissions,
	AgentMode,
} from "./types.js";
