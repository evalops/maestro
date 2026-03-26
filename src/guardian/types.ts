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
	config?: GuardianConfig;
}

/**
 * User-configurable Guardian settings
 * Can be specified in .maestro/guardian.json or ~/.maestro/guardian.json
 */
export interface GuardianConfig {
	/** Enable/disable Guardian globally (default: true) */
	enabled?: boolean;

	/** Enable scanning on git commit/push (default: true) */
	scanGitOperations?: boolean;

	/** Enable scanning on destructive bash commands like rm -rf (default: true) */
	scanDestructiveCommands?: boolean;

	/** Custom secret patterns to detect (in addition to built-in patterns) */
	customSecretPatterns?: string[];

	/** Files/directories to exclude from scanning (merged with DEFAULT_EXCLUDES) */
	excludePatterns?: string[];

	/** Specific tools to enable/disable */
	tools?: {
		semgrep?: boolean;
		gitSecrets?: boolean;
		trufflehog?: boolean;
		heuristicScan?: boolean;
	};

	/** Timeout in milliseconds for individual tool execution (default: 120000) */
	toolTimeoutMs?: number;

	/** Whether to block on findings or just warn (default: true = block) */
	blockOnFindings?: boolean;
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
