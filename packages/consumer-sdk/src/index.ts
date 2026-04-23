import {
	AgentRegistryClient,
	ApprovalsClient,
	ConnectorsClient,
	GovernanceClient,
	IdentityClient,
	LlmGatewayClient,
	MemoryClient,
	MeterClient,
	SkillsClient,
	TracesClient,
} from "./clients.js";
import { EvalOpsTransport } from "./http.js";
import type { EvalOpsClientConfig, EvalOpsClientMetrics } from "./types.js";

export class EvalOpsClient {
	readonly llmGateway: LlmGatewayClient;
	readonly meter: MeterClient;
	readonly approvals: ApprovalsClient;
	readonly memory: MemoryClient;
	readonly traces: TracesClient;
	readonly agentRegistry: AgentRegistryClient;
	readonly skills: SkillsClient;
	readonly identity: IdentityClient;
	readonly governance: GovernanceClient;
	readonly connectors: ConnectorsClient;

	private readonly transport: EvalOpsTransport;

	constructor(config: EvalOpsClientConfig = {}) {
		this.transport = new EvalOpsTransport(config);
		this.llmGateway = new LlmGatewayClient(this.transport);
		this.meter = new MeterClient(this.transport);
		this.approvals = new ApprovalsClient(this.transport);
		this.memory = new MemoryClient(this.transport);
		this.traces = new TracesClient(this.transport);
		this.agentRegistry = new AgentRegistryClient(this.transport);
		this.skills = new SkillsClient(this.transport);
		this.identity = new IdentityClient(this.transport);
		this.governance = new GovernanceClient(this.transport);
		this.connectors = new ConnectorsClient(this.transport);
	}

	static fromEnv(
		overrides: Omit<EvalOpsClientConfig, "baseUrl" | "token"> = {},
	): EvalOpsClient {
		return new EvalOpsClient(overrides);
	}

	get baseUrl(): string {
		return this.transport.baseUrl;
	}

	getMetrics(): EvalOpsClientMetrics {
		return this.transport.getMetrics();
	}

	clearCache(): void {
		this.transport.clearCache();
	}
}

export * from "./clients.js";
export * from "./http.js";
export * from "./types.js";
export * from "@evalops/contracts";
export * as protoContracts from "@evalops/contracts";
