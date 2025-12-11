import { EventEmitter } from "node:events";
import { minimatch } from "minimatch";
import type { Agent } from "../agent/agent.js";
import type { AgentTool, Api, Model } from "../agent/types.js";
import {
	getRegisteredModels,
	resolveAlias,
	resolveModel,
} from "../models/registry.js";
import { createLogger } from "../utils/logger.js";
import { getComposerByName, loadComposers } from "./loader.js";
import type { ComposerState, LoadedComposer } from "./types.js";

const logger = createLogger("composers:manager");

export interface ComposerManagerEvents {
	activated: (composer: LoadedComposer) => void;
	deactivated: (composer: LoadedComposer) => void;
	error: (error: Error) => void;
}

export class ComposerManager extends EventEmitter {
	private state: ComposerState = {
		active: null,
		available: [],
	};
	private baseSystemPrompt = "";
	private baseTools: AgentTool[] = [];
	private baseModel: Model<Api> | null = null;
	private baseTemperature: number | undefined = undefined;
	private baseTopP: number | undefined = undefined;
	private baseThinkingLevel: string | undefined = undefined;
	private agent: Agent | null = null;

	/**
	 * Initialize the composer manager with base configuration
	 */
	initialize(
		agent: Agent,
		baseSystemPrompt: string,
		baseTools: AgentTool[],
		projectRoot?: string,
	): void {
		this.agent = agent;
		this.baseSystemPrompt = baseSystemPrompt;
		this.baseTools = baseTools;
		this.baseModel = agent.state.model;
		this.baseTemperature = agent.state.temperature;
		this.baseTopP = agent.state.topP;
		this.baseThinkingLevel = agent.state.thinkingLevel;
		this.state.available = loadComposers(projectRoot);
	}

	/**
	 * Get the current state
	 */
	getState(): Readonly<ComposerState> {
		return this.state;
	}

	/**
	 * Reload available composers from disk
	 */
	reload(projectRoot?: string): void {
		this.state.available = loadComposers(projectRoot);
	}

	/**
	 * Update base tools without re-initializing (preserves active composer state)
	 */
	updateBaseTools(tools: AgentTool[]): void {
		this.baseTools = tools;
		// If no composer is active, also update the agent's tools
		if (!this.state.active && this.agent) {
			this.agent.setTools(tools);
		}
	}

	/**
	 * Activate a composer by name
	 */
	activate(name: string, projectRoot?: string): boolean {
		const composer = getComposerByName(name, projectRoot);
		if (!composer) {
			this.emit("error", new Error(`Composer '${name}' not found`));
			return false;
		}

		return this.activateComposer(composer);
	}

	/**
	 * Deactivate the current composer, returning to base configuration
	 */
	deactivate(): boolean {
		if (!this.state.active) {
			return false;
		}

		const previous = this.state.active;
		this.state.active = null;

		if (this.agent) {
			// Restore base system prompt
			this.agent.setSystemPrompt(this.baseSystemPrompt);

			// Restore base tools
			this.agent.setTools(this.baseTools);

			// Restore base model if it was changed
			if (this.baseModel) {
				this.agent.setModel(this.baseModel);
			}

			// Restore base temperature and topP
			this.agent.setTemperature(this.baseTemperature);
			this.agent.setTopP(this.baseTopP);

			// Restore base thinking level
			if (this.baseThinkingLevel !== undefined) {
				this.agent.setThinkingLevel(
					this.baseThinkingLevel as
						| "off"
						| "minimal"
						| "low"
						| "medium"
						| "high"
						| "max",
				);
			}
		}

		this.emit("deactivated", previous);
		return true;
	}

	/**
	 * Check if a prompt should trigger a composer activation
	 */
	checkTriggers(prompt: string, projectRoot?: string): LoadedComposer | null {
		for (const composer of this.state.available) {
			if (!composer.triggers) continue;

			// Check keyword triggers
			if (composer.triggers.keywords) {
				const lowerPrompt = prompt.toLowerCase();
				for (const keyword of composer.triggers.keywords) {
					if (lowerPrompt.includes(keyword.toLowerCase())) {
						return composer;
					}
				}
			}
		}

		return null;
	}

	/**
	 * Check if a file path matches any composer triggers
	 */
	checkFileTriggers(
		filePath: string,
		projectRoot?: string,
	): LoadedComposer | null {
		for (const composer of this.state.available) {
			if (!composer.triggers) continue;

			// Check file triggers
			if (composer.triggers.files) {
				for (const pattern of composer.triggers.files) {
					if (minimatch(filePath, pattern)) {
						return composer;
					}
				}
			}

			// Check directory triggers
			if (composer.triggers.directories) {
				for (const pattern of composer.triggers.directories) {
					if (filePath.startsWith(pattern) || minimatch(filePath, pattern)) {
						return composer;
					}
				}
			}
		}

		return null;
	}

	private activateComposer(composer: LoadedComposer): boolean {
		if (!this.agent) {
			this.emit(
				"error",
				new Error("ComposerManager not initialized with agent"),
			);
			return false;
		}

		// Build the new system prompt
		let newSystemPrompt: string;
		const mode = composer.promptMode ?? "append";

		if (mode === "replace" && composer.systemPrompt) {
			newSystemPrompt = composer.systemPrompt;
		} else if (mode === "prepend" && composer.systemPrompt) {
			newSystemPrompt = `${composer.systemPrompt}\n\n${this.baseSystemPrompt}`;
		} else if (composer.systemPrompt) {
			// append (default)
			newSystemPrompt = `${this.baseSystemPrompt}\n\n# Active Composer: ${composer.name}\n\n${composer.systemPrompt}`;
		} else {
			newSystemPrompt = this.baseSystemPrompt;
		}

		// Filter tools based on whitelist and blocklist
		let newTools = this.baseTools;

		// Apply whitelist if specified (only allow listed tools)
		if (composer.tools && composer.tools.length > 0) {
			const allowedSet = new Set(composer.tools);
			newTools = newTools.filter((t) => allowedSet.has(t.name));
		}

		// Apply blocklist if specified (remove denied tools)
		if (composer.denyTools && composer.denyTools.length > 0) {
			const denySet = new Set(composer.denyTools);
			newTools = newTools.filter((t) => !denySet.has(t.name));
		}

		// Apply changes to agent
		this.agent.setSystemPrompt(newSystemPrompt);
		this.agent.setTools(newTools);

		// Change model if specified
		// Supports formats: "provider/modelId", "modelId" (searches all providers), or alias
		if (composer.model) {
			try {
				let resolvedModel = null;

				if (composer.model.includes("/")) {
					// Format: "provider/modelId" (modelId may contain slashes)
					const [provider, ...rest] = composer.model.split("/");
					const modelId = rest.join("/");
					if (provider && modelId) {
						resolvedModel = resolveModel(provider, modelId);
					}
				} else {
					// Try as alias first
					const aliasResolved = resolveAlias(composer.model);
					if (aliasResolved) {
						resolvedModel = resolveModel(
							aliasResolved.provider,
							aliasResolved.modelId,
						);
					} else {
						// Search by model ID across all providers
						resolvedModel =
							getRegisteredModels().find((m) => m.id === composer.model) ??
							null;
					}
				}

				if (resolvedModel) {
					this.agent.setModel(resolvedModel);
				} else {
					logger.warn("Model not found in registry", { model: composer.model });
				}
			} catch (e) {
				logger.warn("Failed to resolve model", {
					model: composer.model,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}

		// Apply temperature if specified
		if (composer.temperature !== undefined) {
			this.agent.setTemperature(composer.temperature);
		}

		// Apply topP if specified
		if (composer.topP !== undefined) {
			this.agent.setTopP(composer.topP);
		}

		// Apply thinking level if specified
		if (composer.thinkingLevel !== undefined) {
			this.agent.setThinkingLevel(composer.thinkingLevel);
		}

		this.state.active = composer;
		this.emit("activated", composer);
		return true;
	}
}

// Singleton instance
export const composerManager = new ComposerManager();
