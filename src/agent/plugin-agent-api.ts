import {
	type PluginAgentConfig,
	type PluginAgentHandle,
	type PluginAgentModeMetadata,
	type PluginAgentModeRegistration,
	type PluginAgentPolicy,
	PluginAgentRegistry,
	type RegisteredPluginAgentMode,
} from "./plugin-agent-registry.js";

export interface PluginAgentApi {
	createAgent(config: PluginAgentConfig): PluginAgentHandle;
	registerAgentMode(registration: PluginAgentModeRegistration): void;
	getAgentMode(key: string): RegisteredPluginAgentMode | undefined;
	listAgentModes(): readonly RegisteredPluginAgentMode[];
}

export function createPluginAgentApi(input: {
	policy: PluginAgentPolicy;
	metadata: readonly PluginAgentModeMetadata[];
}): PluginAgentApi {
	const registry = new PluginAgentRegistry(input.policy, input.metadata);
	return Object.freeze({
		createAgent: registry.createAgent.bind(registry),
		registerAgentMode: registry.registerAgentMode.bind(registry),
		getAgentMode: registry.getAgentMode.bind(registry),
		listAgentModes: registry.listAgentModes.bind(registry),
	});
}

export type {
	PluginAgentBudgets,
	PluginAgentConfig,
	PluginAgentHandle,
	PluginAgentModeMetadata,
	PluginAgentModeRegistration,
	PluginAgentPolicy,
	PluginAgentSandboxMode,
	RegisteredPluginAgentMode,
} from "./plugin-agent-registry.js";
