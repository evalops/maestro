import type { Api, Model } from "../agent/index.js";
import type { AuthCredential } from "../providers/auth.js";
import type { AutomaticMemoryConsolidationCoordinator } from "./auto-consolidation.js";
import type { AutomaticMemoryExtractionCoordinator } from "./auto-extraction.js";

type MemorySessionManager = {
	getSessionFile(): string | null | undefined;
	flush(): Promise<void>;
	saveSessionMemoryExtractionHash(hash: string, sessionPath?: string): void;
};

interface LazyAutoMemoryLoaders {
	loadBackgroundAgent: () => Promise<
		typeof import("../agent/background-agent.js")
	>;
	loadAutoConsolidation: () => Promise<
		typeof import("./auto-consolidation.js")
	>;
	loadAutoExtraction: () => Promise<typeof import("./auto-extraction.js")>;
}

export interface LazyAutoMemoryOptions {
	cwd: string;
	getAuthContext: (
		provider: string,
	) => AuthCredential | undefined | Promise<AuthCredential | undefined>;
	getModel: () => Model<Api>;
	sessionManager: MemorySessionManager;
	loaders?: LazyAutoMemoryLoaders;
}

export interface LazyAutoMemoryCoordinators {
	extraction: AutomaticMemoryExtractionCoordinator;
	flush(): Promise<void>;
}

const defaultLoaders: LazyAutoMemoryLoaders = {
	loadBackgroundAgent: () => import("../agent/background-agent.js"),
	loadAutoConsolidation: () => import("./auto-consolidation.js"),
	loadAutoExtraction: () => import("./auto-extraction.js"),
};

export function createLazyAutoMemoryCoordinators(
	options: LazyAutoMemoryOptions,
): LazyAutoMemoryCoordinators {
	const loaders = options.loaders ?? defaultLoaders;
	const pendingSessionPaths: Array<string | null | undefined> = [];
	let coordinatorPromise:
		| Promise<{
				consolidation: AutomaticMemoryConsolidationCoordinator;
				extraction: AutomaticMemoryExtractionCoordinator;
		  }>
		| undefined;
	let coordinators:
		| {
				consolidation: AutomaticMemoryConsolidationCoordinator;
				extraction: AutomaticMemoryExtractionCoordinator;
		  }
		| undefined;

	const drainPending = (
		extraction: AutomaticMemoryExtractionCoordinator,
	): void => {
		while (pendingSessionPaths.length > 0) {
			extraction.schedule(pendingSessionPaths.shift());
		}
	};

	const ensureCoordinators = async () => {
		if (coordinators) {
			return coordinators;
		}
		coordinatorPromise ??= (async () => {
			const [
				{ createBackgroundTextAgent },
				{
					createAutomaticMemoryConsolidationCoordinator,
					getMemoryConsolidationSystemPrompt,
				},
				{
					createAutomaticMemoryExtractionCoordinator,
					getMemoryExtractionSystemPrompt,
				},
			] = await Promise.all([
				loaders.loadBackgroundAgent(),
				loaders.loadAutoConsolidation(),
				loaders.loadAutoExtraction(),
			]);
			const consolidation = createAutomaticMemoryConsolidationCoordinator({
				createAgent: async () =>
					createBackgroundTextAgent({
						model: options.getModel(),
						systemPrompt: getMemoryConsolidationSystemPrompt(),
						cwd: options.cwd,
						getAuthContext: options.getAuthContext,
					}),
				getModel: options.getModel,
			});
			const extraction = createAutomaticMemoryExtractionCoordinator({
				createAgent: async () =>
					createBackgroundTextAgent({
						model: options.getModel(),
						systemPrompt: getMemoryExtractionSystemPrompt(),
						cwd: options.cwd,
						getAuthContext: options.getAuthContext,
					}),
				getModel: options.getModel,
				onProcessed: () => consolidation.schedule(),
				sessionManager: options.sessionManager,
			});
			coordinators = { consolidation, extraction };
			drainPending(extraction);
			return coordinators;
		})();
		return coordinatorPromise;
	};

	const extraction: AutomaticMemoryExtractionCoordinator = {
		schedule(sessionPath) {
			pendingSessionPaths.push(sessionPath);
			void ensureCoordinators()
				.then(({ extraction }) => {
					drainPending(extraction);
				})
				.catch(() => undefined);
		},
		async flush() {
			if (!coordinatorPromise && pendingSessionPaths.length === 0) {
				return;
			}
			const { extraction, consolidation } = await ensureCoordinators();
			drainPending(extraction);
			await extraction.flush();
			await consolidation.flush();
		},
	};

	return {
		extraction,
		flush: () => extraction.flush(),
	};
}
