export type GuardianTarget = "staged" | "all";

export type GuardianStatus = "passed" | "failed" | "skipped" | "error";

export interface GuardianToolResult {
	tool: string;
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	skipped?: boolean;
	reason?: string;
}

export interface GuardianRunResult {
	status: GuardianStatus;
	exitCode: number;
	startedAt: number;
	durationMs: number;
	target: GuardianTarget;
	trigger?: string;
	filesScanned: number;
	files?: string[];
	summary: string;
	skipReason?: string;
	toolResults: GuardianToolResult[];
}

export interface GuardianState {
	enabled: boolean;
	lastRun?: GuardianRunResult;
}

export interface GuardianEnablement {
	enabled: boolean;
	reason?: string;
	envOverride?: "disabled" | "enabled";
}

export interface GuardianRunOptions {
	target?: GuardianTarget;
	trigger?: string;
	root?: string;
	respectEnv?: boolean;
	quiet?: boolean;
}

export interface GuardianFormatOptions {
	compact?: boolean;
	includeFiles?: boolean;
}

export const DEFAULT_EXCLUDES = [
	"node_modules/",
	"dist/",
	"tmp/",
	".git/",
	"coverage/",
	"build/",
	"out/",
	".turbo/",
];
