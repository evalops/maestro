type FinalizedEnvLoad = {
	loadedEnvKeys: string[];
	scrubbedEnvKeys: string[];
};

type LoadEnvModuleMockInput = {
	finalizeLoadedEnv?: (loadedEnvKeys?: string[]) => FinalizedEnvLoad;
	getLoadedEnvKeys?: () => string[];
	loadAndFinalizeEnv?: () => FinalizedEnvLoad;
	loadEnv?: () => string[];
	scrubLoadedSecurityOverrideEnv?: () => string[];
};

export function createLoadEnvModuleMock(input: LoadEnvModuleMockInput = {}) {
	const loadEnv = input.loadEnv ?? (() => []);
	const scrubLoadedSecurityOverrideEnv =
		input.scrubLoadedSecurityOverrideEnv ?? (() => []);
	const finalizeLoadedEnv =
		input.finalizeLoadedEnv ??
		((loadedEnvKeys: string[] = []) => ({
			loadedEnvKeys,
			scrubbedEnvKeys: scrubLoadedSecurityOverrideEnv(),
		}));
	const loadAndFinalizeEnv =
		input.loadAndFinalizeEnv ?? (() => finalizeLoadedEnv(loadEnv()));
	const getLoadedEnvKeys = input.getLoadedEnvKeys ?? (() => []);

	return {
		finalizeLoadedEnv,
		getLoadedEnvKeys,
		loadAndFinalizeEnv,
		loadEnv,
		scrubLoadedSecurityOverrideEnv,
	};
}
