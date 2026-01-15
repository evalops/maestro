/**
 * Attack Patterns - Sophisticated threat detection patterns
 *
 * Defines multi-step attack patterns for credential harvesting,
 * data exfiltration, privilege escalation, and reconnaissance.
 *
 * These patterns extend the base tool-sequence-analyzer with
 * more sophisticated detection logic.
 *
 * @module safety/attack-patterns
 */

import type { SequencePattern } from "./tool-sequence-analyzer.js";

/**
 * Attack pattern categories
 */
export type AttackCategory =
	| "credential_harvesting"
	| "data_exfiltration"
	| "privilege_escalation"
	| "reconnaissance"
	| "persistence"
	| "defense_evasion";

/**
 * Extended metadata for attack patterns
 */
export interface AttackPatternMetadata {
	/** Attack category */
	category: AttackCategory;
	/** MITRE ATT&CK technique ID (if applicable) */
	mitreId?: string;
	/** Detailed description of the attack */
	attackDescription: string;
	/** Indicators of compromise */
	iocs: string[];
}

/**
 * Registry mapping pattern IDs to their metadata
 */
export const ATTACK_PATTERN_METADATA: Record<string, AttackPatternMetadata> = {
	"cred-harvest-env-egress": {
		category: "credential_harvesting",
		mitreId: "T1552.001",
		attackDescription:
			"Attacker reads environment variables containing API keys or credentials, then attempts to exfiltrate via HTTP request.",
		iocs: ["env command execution", "environment variable access", "HTTP POST"],
	},
	"cred-harvest-config-file": {
		category: "credential_harvesting",
		mitreId: "T1552.001",
		attackDescription:
			"Attacker reads configuration files known to contain credentials, then exfiltrates via network.",
		iocs: [".env file access", "credentials file read", "config enumeration"],
	},
	"cred-harvest-git": {
		category: "credential_harvesting",
		mitreId: "T1552.001",
		attackDescription:
			"Attacker extracts Git credentials or repository tokens for unauthorized access.",
		iocs: ["git config access", "credential helper extraction"],
	},
	"cred-harvest-keychain": {
		category: "credential_harvesting",
		mitreId: "T1555.001",
		attackDescription:
			"Attacker attempts to extract credentials from system keychain or secret store.",
		iocs: ["keychain access", "credential manager query"],
	},
	"exfil-archive-egress": {
		category: "data_exfiltration",
		mitreId: "T1560.001",
		attackDescription:
			"Attacker creates compressed archive of collected data, then exfiltrates via HTTP.",
		iocs: ["archive creation", "compression", "network transfer"],
	},
	"exfil-db-dump": {
		category: "data_exfiltration",
		mitreId: "T1005",
		attackDescription:
			"Attacker dumps database contents for exfiltration. May contain sensitive user data.",
		iocs: ["database dump", "bulk data extraction", "SQL export"],
	},
	"exfil-curl-post": {
		category: "data_exfiltration",
		mitreId: "T1041",
		attackDescription:
			"Attacker reads sensitive files and exfiltrates via curl POST request.",
		iocs: ["curl POST", "data upload", "external transfer"],
	},
	"privesc-suid-search": {
		category: "privilege_escalation",
		mitreId: "T1548.001",
		attackDescription:
			"Attacker searches for SUID/SGID binaries that could be exploited for privilege escalation.",
		iocs: ["SUID search", "permission enumeration", "binary discovery"],
	},
	"privesc-cron-modify": {
		category: "privilege_escalation",
		mitreId: "T1053.003",
		attackDescription:
			"Attacker writes to cron directories to schedule privileged command execution.",
		iocs: ["cron modification", "scheduled task creation"],
	},
	"recon-network-scan": {
		category: "reconnaissance",
		mitreId: "T1046",
		attackDescription:
			"Attacker scans network to discover other systems and services.",
		iocs: ["port scanning", "network enumeration", "service discovery"],
	},
	"persist-ssh-key": {
		category: "persistence",
		mitreId: "T1098.004",
		attackDescription:
			"Attacker installs SSH key for persistent unauthorized access.",
		iocs: ["authorized_keys modification", "SSH key creation"],
	},
	"persist-shell-profile": {
		category: "persistence",
		mitreId: "T1546.004",
		attackDescription:
			"Attacker modifies shell startup files to execute commands on user login.",
		iocs: ["shell profile modification", "login hook"],
	},
	"persist-systemd": {
		category: "persistence",
		mitreId: "T1543.002",
		attackDescription:
			"Attacker creates systemd service for automatic execution on boot.",
		iocs: ["systemd unit creation", "service installation"],
	},
	"evasion-log-clear": {
		category: "defense_evasion",
		mitreId: "T1070.002",
		attackDescription:
			"Attacker attempts to clear logs to hide malicious activity.",
		iocs: ["log truncation", "history clearing", "audit log modification"],
	},
	"cred-cloud-metadata": {
		category: "credential_harvesting",
		mitreId: "T1552.005",
		attackDescription:
			"Attacker accesses cloud metadata service to steal instance credentials or secrets.",
		iocs: ["169.254.169.254 access", "metadata service query", "IMDSv1 abuse"],
	},
	"lateral-ssh-movement": {
		category: "reconnaissance",
		mitreId: "T1570",
		attackDescription:
			"Attacker reads SSH keys and attempts lateral movement to other systems.",
		iocs: ["SSH key access", "multiple SSH connections", "lateral movement"],
	},
	"privesc-docker-socket": {
		category: "privilege_escalation",
		mitreId: "T1552.003",
		attackDescription:
			"Attacker accesses Docker socket to escape container or escalate privileges.",
		iocs: ["docker.sock access", "container escape", "privileged container"],
	},
	"persist-ld-preload": {
		category: "persistence",
		mitreId: "T1574.006",
		attackDescription:
			"Attacker sets LD_PRELOAD to inject malicious shared library at runtime.",
		iocs: ["LD_PRELOAD injection", "shared library hijacking", "profile modification"],
	},
	"cred-proc-memory": {
		category: "credential_harvesting",
		mitreId: "T1552.001",
		attackDescription:
			"Attacker extracts credentials from process memory using debugging tools.",
		iocs: ["process memory access", "gdb attach", "/proc/*/mem read"],
	},
	"persist-git-hooks": {
		category: "persistence",
		mitreId: "T1547.010",
		attackDescription:
			"Attacker installs malicious git hooks that execute on repository operations.",
		iocs: ["git hooks modification", "post-checkout hook", "pre-commit hook"],
	},
	"persist-pam-backdoor": {
		category: "persistence",
		mitreId: "T1556.003",
		attackDescription:
			"Attacker modifies PAM configuration to install authentication backdoor.",
		iocs: ["PAM modification", "/etc/pam.d access", "authentication bypass"],
	},
};

/**
 * Helper to check if a command contains certain patterns
 */
function commandMatches(
	args: Record<string, unknown>,
	pattern: RegExp,
): boolean {
	const command = args.command as string | undefined;
	return command ? pattern.test(command) : false;
}

/**
 * Helper to check if a path matches sensitive patterns
 */
function pathMatches(args: Record<string, unknown>, pattern: RegExp): boolean {
	const path =
		(args.path as string) ||
		(args.file_path as string) ||
		(args.target as string);
	return path ? pattern.test(path) : false;
}

/**
 * Credential Harvesting Patterns
 */
export const CREDENTIAL_HARVESTING_PATTERNS: SequencePattern[] = [
	{
		id: "cred-harvest-env-egress",
		description: "Environment variable read followed by network egress",
		severity: "high",
		action: "block",
		windowMs: 120_000,
		detect: (records, currentTool, _currentArgs) => {
			const normalizedTool = currentTool.toLowerCase();
			// Check if current operation is network egress
			if (
				!normalizedTool.includes("fetch") &&
				!normalizedTool.includes("http") &&
				!normalizedTool.includes("curl")
			) {
				return { matched: false };
			}

			// Look for recent env reads
			const envReads = records.filter((r) => {
				const ageMs = Date.now() - r.timestamp;
				if (ageMs > 120_000) return false;
				const cmd = (r.args.command as string) || "";
				return /\benv\b|printenv|export|echo.*\$[A-Z_]+/.test(cmd);
			});

			if (envReads.length > 0) {
				return {
					matched: true,
					reason: `Network egress after environment variable access - possible credential exfiltration`,
					matchingRecords: envReads,
				};
			}
			return { matched: false };
		},
	},
	{
		id: "cred-harvest-config-file",
		description: "Read credential files then network egress",
		severity: "high",
		action: "block",
		windowMs: 180_000,
		detect: (records, currentTool, _currentArgs) => {
			const normalizedTool = currentTool.toLowerCase();
			if (
				!normalizedTool.includes("fetch") &&
				!normalizedTool.includes("http")
			) {
				return { matched: false };
			}

			const credFilePattern =
				/\.env|credentials|\.aws\/|\.ssh\/|\.netrc|\.npmrc|\.pypirc/i;
			const credReads = records.filter((r) => {
				const ageMs = Date.now() - r.timestamp;
				if (ageMs > 180_000) return false;
				return (
					r.tags.has("read") &&
					pathMatches(r.args, credFilePattern)
				);
			});

			if (credReads.length > 0) {
				return {
					matched: true,
					reason: `Network egress after reading credential files: ${credReads.map((r) => r.args.path || r.args.file_path).join(", ")}`,
					matchingRecords: credReads,
				};
			}
			return { matched: false };
		},
	},
	{
		id: "cred-harvest-git",
		description: "Read git credentials then egress",
		severity: "high",
		action: "block",
		windowMs: 120_000,
		detect: (records, currentTool, _currentArgs) => {
			const normalizedTool = currentTool.toLowerCase();
			if (
				!normalizedTool.includes("fetch") &&
				!normalizedTool.includes("http")
			) {
				return { matched: false };
			}

			const gitCredPattern = /\.git\/config|\.gitconfig|\.git-credentials/i;
			const gitReads = records.filter((r) => {
				const ageMs = Date.now() - r.timestamp;
				if (ageMs > 120_000) return false;
				return r.tags.has("read") && pathMatches(r.args, gitCredPattern);
			});

			if (gitReads.length > 0) {
				return {
					matched: true,
					reason: `Network egress after reading git credentials`,
					matchingRecords: gitReads,
				};
			}
			return { matched: false };
		},
	},
	{
		id: "cred-harvest-keychain",
		description: "Attempt to access system keychain",
		severity: "critical",
		action: "block",
		windowMs: 60_000,
		detect: (_records, currentTool, currentArgs) => {
			if (currentTool.toLowerCase() !== "bash") {
				return { matched: false };
			}

			const keychainPattern =
				/security\s+find-generic-password|secret-tool|keyctl|kwallet/i;
			if (commandMatches(currentArgs, keychainPattern)) {
				return {
					matched: true,
					reason: `Keychain/secret store access attempt detected`,
				};
			}
			return { matched: false };
		},
	},
	{
		id: "cred-cloud-metadata",
		description: "Access cloud metadata service for credentials",
		severity: "critical",
		action: "block",
		windowMs: 60_000,
		detect: (_records, currentTool, currentArgs) => {
			// Check for metadata service access in URLs or curl commands
			const metadataPattern = /169\.254\.169\.254|metadata\.google\.internal|169\.254\.170\.2/i;

			if (currentTool.toLowerCase() === "bash") {
				if (commandMatches(currentArgs, metadataPattern)) {
					return {
						matched: true,
						reason: `Cloud metadata service access detected - possible credential theft`,
					};
				}
			}

			// Also check WebFetch URLs
			const normalizedTool = currentTool.toLowerCase();
			if (normalizedTool.includes("fetch") || normalizedTool.includes("http")) {
				const url = currentArgs.url as string;
				if (url && metadataPattern.test(url)) {
					return {
						matched: true,
						reason: `Cloud metadata service access via HTTP - possible credential theft`,
					};
				}
			}
			return { matched: false };
		},
	},
	{
		id: "cred-proc-memory",
		description: "Extract credentials from process memory",
		severity: "critical",
		action: "block",
		windowMs: 60_000,
		detect: (_records, currentTool, currentArgs) => {
			if (currentTool.toLowerCase() !== "bash") {
				return { matched: false };
			}

			// Detect process memory theft attempts
			const procMemPattern = /gdb\s+(attach|-p)|\/proc\/\d+\/mem|strings\s+\/proc|cat\s+\/proc\/\d+/i;
			if (commandMatches(currentArgs, procMemPattern)) {
				return {
					matched: true,
					reason: `Process memory access detected - possible credential extraction`,
				};
			}
			return { matched: false };
		},
	},
];

/**
 * Data Exfiltration Patterns
 */
export const DATA_EXFILTRATION_PATTERNS: SequencePattern[] = [
	{
		id: "exfil-archive-egress",
		description: "Create archive then network transfer",
		severity: "high",
		action: "block",
		windowMs: 180_000,
		detect: (records, currentTool, _currentArgs) => {
			const normalizedTool = currentTool.toLowerCase();
			if (
				!normalizedTool.includes("fetch") &&
				!normalizedTool.includes("http") &&
				!normalizedTool.includes("curl")
			) {
				return { matched: false };
			}

			const archivePattern = /\b(tar|zip|7z|gzip|bzip2|xz)\b.*-[a-z]*[cf]/i;
			const archiveOps = records.filter((r) => {
				const ageMs = Date.now() - r.timestamp;
				if (ageMs > 180_000) return false;
				return commandMatches(r.args, archivePattern);
			});

			if (archiveOps.length > 0) {
				return {
					matched: true,
					reason: `Network egress after creating archive - possible data exfiltration`,
					matchingRecords: archiveOps,
				};
			}
			return { matched: false };
		},
	},
	{
		id: "exfil-db-dump",
		description: "Database dump followed by network transfer",
		severity: "critical",
		action: "block",
		windowMs: 300_000,
		detect: (records, currentTool, _currentArgs) => {
			const normalizedTool = currentTool.toLowerCase();
			if (
				!normalizedTool.includes("fetch") &&
				!normalizedTool.includes("http")
			) {
				return { matched: false };
			}

			const dbDumpPattern =
				/pg_dump|mysqldump|mongodump|sqlite3.*\.dump|redis-cli.*save/i;
			const dbDumps = records.filter((r) => {
				const ageMs = Date.now() - r.timestamp;
				if (ageMs > 300_000) return false;
				return commandMatches(r.args, dbDumpPattern);
			});

			if (dbDumps.length > 0) {
				return {
					matched: true,
					reason: `Network egress after database dump - critical data exfiltration risk`,
					matchingRecords: dbDumps,
				};
			}
			return { matched: false };
		},
	},
	{
		id: "exfil-curl-post",
		description: "Read sensitive data then curl POST",
		severity: "critical",
		action: "block",
		windowMs: 120_000,
		detect: (records, currentTool, currentArgs) => {
			if (currentTool.toLowerCase() !== "bash") {
				return { matched: false };
			}

			const curlPostPattern = /curl.*(-X\s*POST|--data|--data-binary|-d\s)/i;
			if (!commandMatches(currentArgs, curlPostPattern)) {
				return { matched: false };
			}

			const sensitivePattern = /\.env|secret|credential|password|key|token/i;
			const sensitiveReads = records.filter((r) => {
				const ageMs = Date.now() - r.timestamp;
				if (ageMs > 120_000) return false;
				return r.tags.has("read") && pathMatches(r.args, sensitivePattern);
			});

			if (sensitiveReads.length > 0) {
				return {
					matched: true,
					reason: `Curl POST after reading sensitive files - possible credential exfiltration`,
					matchingRecords: sensitiveReads,
				};
			}
			return { matched: false };
		},
	},
];

/**
 * Privilege Escalation Patterns
 */
export const PRIVILEGE_ESCALATION_PATTERNS: SequencePattern[] = [
	{
		id: "privesc-suid-search",
		description: "Find SUID binaries for exploitation",
		severity: "high",
		action: "block",
		windowMs: 60_000,
		detect: (_records, currentTool, currentArgs) => {
			if (currentTool.toLowerCase() !== "bash") {
				return { matched: false };
			}

			const suidPattern = /find.*-perm.*(4000|2000|-u=s)/i;
			if (commandMatches(currentArgs, suidPattern)) {
				return {
					matched: true,
					reason: `SUID binary search detected - possible privilege escalation reconnaissance`,
				};
			}
			return { matched: false };
		},
	},
	{
		id: "privesc-cron-modify",
		description: "Modify cron jobs for persistence/escalation",
		severity: "critical",
		action: "block",
		windowMs: 60_000,
		detect: (_records, currentTool, currentArgs) => {
			const cronPattern = /\/etc\/cron|crontab|\/var\/spool\/cron/i;
			if (
				currentTool.toLowerCase() === "write" ||
				currentTool.toLowerCase() === "edit"
			) {
				if (pathMatches(currentArgs, cronPattern)) {
					return {
						matched: true,
						reason: `Cron job modification detected - possible privilege escalation or persistence`,
					};
				}
			}
			return { matched: false };
		},
	},
	{
		id: "privesc-docker-socket",
		description: "Access Docker socket for container escape or privilege escalation",
		severity: "critical",
		action: "block",
		windowMs: 60_000,
		detect: (_records, currentTool, currentArgs) => {
			// Detect Docker socket access
			const dockerSocketPattern = /docker\.sock|\/var\/run\/docker|docker\s+run.*--privileged|docker\s+exec/i;

			if (currentTool.toLowerCase() === "bash") {
				if (commandMatches(currentArgs, dockerSocketPattern)) {
					return {
						matched: true,
						reason: `Docker socket access detected - possible container escape or privilege escalation`,
					};
				}
			}

			// Also check for direct file reads of docker socket
			if (currentTool.toLowerCase() === "read") {
				const sockPattern = /docker\.sock|\/var\/run\/docker/i;
				if (pathMatches(currentArgs, sockPattern)) {
					return {
						matched: true,
						reason: `Docker socket read detected - possible privilege escalation`,
					};
				}
			}
			return { matched: false };
		},
	},
];

/**
 * Reconnaissance Patterns
 */
export const RECONNAISSANCE_PATTERNS: SequencePattern[] = [
	{
		id: "recon-network-scan",
		description: "Network scanning and enumeration",
		severity: "high",
		action: "block",
		windowMs: 120_000,
		detect: (_records, currentTool, currentArgs) => {
			if (currentTool.toLowerCase() !== "bash") {
				return { matched: false };
			}

			const networkScanPattern = /\b(nmap|netstat|ss\s+-|lsof\s+-i|arp\s)\b/i;
			if (commandMatches(currentArgs, networkScanPattern)) {
				return {
					matched: true,
					reason: `Network scanning detected - possible reconnaissance activity`,
				};
			}
			return { matched: false };
		},
	},
	{
		id: "lateral-ssh-movement",
		description: "SSH key access followed by SSH connection attempts",
		severity: "critical",
		action: "block",
		windowMs: 180_000,
		detect: (records, currentTool, currentArgs) => {
			if (currentTool.toLowerCase() !== "bash") {
				return { matched: false };
			}

			// Check if current command is SSH connection
			const sshConnectPattern = /\bssh\s+[^-]|ssh\s+-[^-]*\s+\w/i;
			if (!commandMatches(currentArgs, sshConnectPattern)) {
				return { matched: false };
			}

			// Look for recent SSH key reads
			const sshKeyPattern = /\.ssh\/id_|\.ssh\/.*_key|\.ssh\/config/i;
			const sshKeyReads = records.filter((r) => {
				const ageMs = Date.now() - r.timestamp;
				if (ageMs > 180_000) return false;
				return r.tags.has("read") && pathMatches(r.args, sshKeyPattern);
			});

			if (sshKeyReads.length > 0) {
				return {
					matched: true,
					reason: `SSH connection attempt after reading SSH keys - possible lateral movement`,
					matchingRecords: sshKeyReads,
				};
			}
			return { matched: false };
		},
	},
];

/**
 * Persistence Patterns
 */
export const PERSISTENCE_PATTERNS: SequencePattern[] = [
	{
		id: "persist-ssh-key",
		description: "Write to SSH authorized_keys",
		severity: "critical",
		action: "block",
		windowMs: 60_000,
		detect: (_records, currentTool, currentArgs) => {
			const sshPattern = /\.ssh\/authorized_keys|\.ssh\/id_/i;
			if (
				currentTool.toLowerCase() === "write" ||
				currentTool.toLowerCase() === "edit"
			) {
				if (pathMatches(currentArgs, sshPattern)) {
					return {
						matched: true,
						reason: `SSH key installation detected - possible unauthorized access persistence`,
					};
				}
			}
			return { matched: false };
		},
	},
	{
		id: "persist-shell-profile",
		description: "Modify shell startup files",
		severity: "high",
		action: "require_approval",
		windowMs: 60_000,
		detect: (_records, currentTool, currentArgs) => {
			const profilePattern =
				/\.bashrc|\.bash_profile|\.zshrc|\.profile|\.bash_login/i;
			if (
				currentTool.toLowerCase() === "write" ||
				currentTool.toLowerCase() === "edit"
			) {
				if (pathMatches(currentArgs, profilePattern)) {
					return {
						matched: true,
						reason: `Shell profile modification detected - may establish persistence`,
					};
				}
			}
			return { matched: false };
		},
	},
	{
		id: "persist-systemd",
		description: "Create systemd service for persistence",
		severity: "critical",
		action: "block",
		windowMs: 60_000,
		detect: (_records, currentTool, currentArgs) => {
			const systemdPattern = /\/etc\/systemd|\.config\/systemd|\.service$/i;
			if (
				currentTool.toLowerCase() === "write" ||
				currentTool.toLowerCase() === "edit"
			) {
				if (pathMatches(currentArgs, systemdPattern)) {
					return {
						matched: true,
						reason: `Systemd service creation detected - possible persistence mechanism`,
					};
				}
			}
			return { matched: false };
		},
	},
	{
		id: "persist-ld-preload",
		description: "LD_PRELOAD injection via shell profile modification",
		severity: "critical",
		action: "block",
		windowMs: 60_000,
		detect: (_records, currentTool, currentArgs) => {
			// Check for LD_PRELOAD being written to profile files
			if (
				currentTool.toLowerCase() === "write" ||
				currentTool.toLowerCase() === "edit" ||
				currentTool.toLowerCase() === "bash"
			) {
				// Check for LD_PRELOAD in command or file content
				const ldPreloadPattern = /LD_PRELOAD/i;
				const profilePattern = /\.bashrc|\.bash_profile|\.zshrc|\.profile|\/etc\/environment|\/etc\/ld\.so\.preload/i;

				if (currentTool.toLowerCase() === "bash") {
					if (commandMatches(currentArgs, ldPreloadPattern)) {
						return {
							matched: true,
							reason: `LD_PRELOAD injection attempt detected - possible persistence mechanism`,
						};
					}
				} else if (pathMatches(currentArgs, profilePattern)) {
					// If writing to profile files, check for LD_PRELOAD in content
					const content = currentArgs.content as string;
					if (content && ldPreloadPattern.test(content)) {
						return {
							matched: true,
							reason: `LD_PRELOAD written to shell profile - possible persistence mechanism`,
						};
					}
				}
			}
			return { matched: false };
		},
	},
	{
		id: "persist-git-hooks",
		description: "Modify git hooks for code execution",
		severity: "critical",
		action: "block",
		windowMs: 60_000,
		detect: (_records, currentTool, currentArgs) => {
			const gitHooksPattern = /\.git\/hooks\//i;
			if (
				currentTool.toLowerCase() === "write" ||
				currentTool.toLowerCase() === "edit"
			) {
				if (pathMatches(currentArgs, gitHooksPattern)) {
					return {
						matched: true,
						reason: `Git hooks modification detected - possible persistence mechanism`,
					};
				}
			}
			return { matched: false };
		},
	},
	{
		id: "persist-pam-backdoor",
		description: "Modify PAM configuration for authentication bypass",
		severity: "critical",
		action: "block",
		windowMs: 60_000,
		detect: (_records, currentTool, currentArgs) => {
			const pamPattern = /\/etc\/pam\.d\/|\/etc\/pam\.conf|pam_.*\.so/i;
			if (
				currentTool.toLowerCase() === "write" ||
				currentTool.toLowerCase() === "edit"
			) {
				if (pathMatches(currentArgs, pamPattern)) {
					return {
						matched: true,
						reason: `PAM configuration modification detected - possible authentication backdoor`,
					};
				}
			}
			return { matched: false };
		},
	},
];

/**
 * Defense Evasion Patterns
 */
export const DEFENSE_EVASION_PATTERNS: SequencePattern[] = [
	{
		id: "evasion-log-clear",
		description: "Attempt to clear system logs",
		severity: "critical",
		action: "block",
		windowMs: 60_000,
		detect: (_records, currentTool, currentArgs) => {
			if (currentTool.toLowerCase() !== "bash") {
				return { matched: false };
			}

			const logClearPattern =
				/>\s*\/var\/log|rm\s.*\/var\/log|truncate.*\/var\/log|history\s+-c/i;
			if (commandMatches(currentArgs, logClearPattern)) {
				return {
					matched: true,
					reason: `Log clearing attempt detected - possible evidence destruction`,
				};
			}
			return { matched: false };
		},
	},
];

/**
 * All attack patterns combined
 */
export const ALL_ATTACK_PATTERNS: SequencePattern[] = [
	...CREDENTIAL_HARVESTING_PATTERNS,
	...DATA_EXFILTRATION_PATTERNS,
	...PRIVILEGE_ESCALATION_PATTERNS,
	...RECONNAISSANCE_PATTERNS,
	...PERSISTENCE_PATTERNS,
	...DEFENSE_EVASION_PATTERNS,
];

/**
 * Get metadata for an attack pattern
 */
export function getPatternMetadata(
	patternId: string,
): AttackPatternMetadata | undefined {
	return ATTACK_PATTERN_METADATA[patternId];
}

/**
 * Get patterns by category
 */
export function getPatternsByCategory(
	category: AttackCategory,
): SequencePattern[] {
	return ALL_ATTACK_PATTERNS.filter((p) => {
		const meta = ATTACK_PATTERN_METADATA[p.id];
		return meta?.category === category;
	});
}

/**
 * Get patterns by severity
 */
export function getPatternsBySeverity(
	severity: "low" | "medium" | "high" | "critical",
): SequencePattern[] {
	return ALL_ATTACK_PATTERNS.filter((p) => p.severity === severity);
}
