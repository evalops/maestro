import type { ApprovalMode } from "./action-approval.js";

export type PluginAgentSandboxMode =
	| "danger-full-access"
	| "workspace-write"
	| "read-only";

export interface PluginAgentBudgets {
	maxTurns: number;
	maxToolCalls: number;
	maxCostUsd: number;
}

export interface PluginAgentPolicy {
	allowedModels: readonly string[];
	allowedTools: readonly string[];
	maxBudgets: PluginAgentBudgets;
	approvalMode: ApprovalMode;
	sandboxMode: PluginAgentSandboxMode;
}

export interface PluginAgentModeMetadata {
	key: string;
	label: string;
	entry: string;
}

export interface PluginAgentConfig {
	key: string;
	label: string;
	description: string;
	systemPrompt: string;
	model: string;
	tools: "all" | readonly string[];
	budgets: PluginAgentBudgets;
	approvalMode: ApprovalMode;
	sandboxMode: PluginAgentSandboxMode;
}

export interface PluginAgentHandle {
	readonly key: string;
	readonly label: string;
	readonly description: string;
	readonly systemPrompt: string;
	readonly model: string;
	readonly tools: readonly string[];
	readonly budgets: Readonly<PluginAgentBudgets>;
	readonly approvalMode: ApprovalMode;
	readonly sandboxMode: PluginAgentSandboxMode;
}

export interface PluginAgentModeRegistration {
	key: string;
	label: string;
	agent: PluginAgentHandle;
	primary: boolean;
}

export interface RegisteredPluginAgentMode extends PluginAgentModeRegistration {
	readonly metadata: Readonly<PluginAgentModeMetadata>;
}

const KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const APPROVAL_RESTRICTIVENESS: Record<ApprovalMode, number> = {
	auto: 0,
	prompt: 1,
	fail: 2,
};
const SANDBOX_RESTRICTIVENESS: Record<PluginAgentSandboxMode, number> = {
	"danger-full-access": 0,
	"workspace-write": 1,
	"read-only": 2,
};

function validatePositiveBudget(
	name: keyof PluginAgentBudgets,
	requested: number | undefined,
	maximum: number | undefined,
): void {
	if (
		requested === undefined ||
		!Number.isFinite(requested) ||
		requested <= 0 ||
		(maximum !== undefined && requested > maximum)
	) {
		throw new Error(`Plugin agent budget ${name} is invalid or exceeds policy`);
	}
}

function freezeHandle(
	config: PluginAgentConfig,
	tools: readonly string[],
): PluginAgentHandle {
	return Object.freeze({
		key: config.key,
		label: config.label,
		description: config.description,
		systemPrompt: config.systemPrompt,
		model: config.model,
		tools: Object.freeze([...tools]),
		budgets: Object.freeze({ ...config.budgets }),
		approvalMode: config.approvalMode,
		sandboxMode: config.sandboxMode,
	});
}

export class PluginAgentRegistry {
	private readonly policy: PluginAgentPolicy;
	private readonly metadata = new Map<
		string,
		Readonly<PluginAgentModeMetadata>
	>();
	private readonly registrations = new Map<string, RegisteredPluginAgentMode>();
	private readonly issuedHandles = new WeakSet<PluginAgentHandle>();

	constructor(
		policy: PluginAgentPolicy,
		metadata: readonly PluginAgentModeMetadata[],
	) {
		this.policy = Object.freeze({
			...policy,
			allowedModels: Object.freeze([...policy.allowedModels]),
			allowedTools: Object.freeze([...policy.allowedTools]),
			maxBudgets: Object.freeze({ ...policy.maxBudgets }),
		});
		for (const declaration of metadata) {
			if (!KEY_PATTERN.test(declaration.key) || !declaration.entry.trim()) {
				throw new Error(`Invalid plugin agent metadata for ${declaration.key}`);
			}
			if (this.metadata.has(declaration.key)) {
				throw new Error(`Duplicate plugin agent metadata: ${declaration.key}`);
			}
			this.metadata.set(declaration.key, Object.freeze({ ...declaration }));
		}
	}

	createAgent(config: PluginAgentConfig): PluginAgentHandle {
		if (!KEY_PATTERN.test(config.key)) {
			throw new Error("Plugin agent key must be lowercase kebab-case");
		}
		if (
			!config.label.trim() ||
			!config.description.trim() ||
			!config.systemPrompt.trim()
		) {
			throw new Error("Plugin agent text fields must be non-empty");
		}
		if (!this.policy.allowedModels.includes(config.model)) {
			throw new Error(`Plugin agent model is not allowed: ${config.model}`);
		}

		const tools =
			config.tools === "all" ? this.policy.allowedTools : config.tools;
		const unknownTool = tools.find(
			(tool) => !this.policy.allowedTools.includes(tool),
		);
		if (unknownTool) {
			throw new Error(`Plugin agent tool is not allowed: ${unknownTool}`);
		}
		validatePositiveBudget(
			"maxTurns",
			config.budgets.maxTurns,
			this.policy.maxBudgets.maxTurns,
		);
		validatePositiveBudget(
			"maxToolCalls",
			config.budgets.maxToolCalls,
			this.policy.maxBudgets.maxToolCalls,
		);
		validatePositiveBudget(
			"maxCostUsd",
			config.budgets.maxCostUsd,
			this.policy.maxBudgets.maxCostUsd,
		);
		if (
			APPROVAL_RESTRICTIVENESS[config.approvalMode] <
			APPROVAL_RESTRICTIVENESS[this.policy.approvalMode]
		) {
			throw new Error("Plugin agent approval mode would escalate permission");
		}
		if (
			SANDBOX_RESTRICTIVENESS[config.sandboxMode] <
			SANDBOX_RESTRICTIVENESS[this.policy.sandboxMode]
		) {
			throw new Error("Plugin agent sandbox mode would escalate permission");
		}

		const handle = freezeHandle(config, tools);
		this.issuedHandles.add(handle);
		return handle;
	}

	registerAgentMode(registration: PluginAgentModeRegistration): void {
		if (this.registrations.has(registration.key)) {
			throw new Error(`Duplicate plugin agent mode: ${registration.key}`);
		}
		const metadata = this.metadata.get(registration.key);
		if (
			!metadata ||
			metadata.label !== registration.label ||
			registration.agent.key !== registration.key ||
			registration.agent.label !== registration.label
		) {
			throw new Error(
				`Plugin agent registration metadata mismatch: ${registration.key}`,
			);
		}
		if (!this.issuedHandles.has(registration.agent)) {
			throw new Error("Plugin agent handle was not issued by this registry");
		}

		this.registrations.set(
			registration.key,
			Object.freeze({ ...registration, metadata }),
		);
	}

	getAgentMode(key: string): RegisteredPluginAgentMode | undefined {
		return this.registrations.get(key);
	}

	listAgentModes(): readonly RegisteredPluginAgentMode[] {
		return Object.freeze([...this.registrations.values()]);
	}
}
