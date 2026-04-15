export const dangerousPatterns = {
	// Recursive delete with force
	rmRf: /\brm\s+-[^\n]*-?r[^\n]*-?f[^\n]*\s+(?:-+\w+\s+)*(["']?\/?[\w.*\-\s]*|\.)/i,

	// Remote script execution via pipe
	curlPipeShell: /(curl|wget)[\s\S]*?\|\s*(bash|sh|zsh|fish|csh|tcsh)/i,

	// Bash process substitution pulling from the network
	bashProcessSubstitution: /bash\s*<\s*\(\s*(curl|wget)/i,

	// Filesystem formatting
	mkfs: /\bmkfs\b|\bmkfs\.[a-z0-9]+/i,

	// Disk zeroing
	diskZero: /dd\s+if=\/dev\/(?:zero|null)/i,

	// Privilege escalation via sudoers edits
	sudoersNopasswd: /echo.*NOPASSWD.*>.*\/etc\/sudoers(?:\.d\/?[^\s]*)?/i,

	// System service persistence
	systemdService: /(systemctl.*enable|.*\.service.*>\/etc\/systemd)/i,

	// Cron persistence
	crontabModification:
		/(crontab\s+-e|echo.*>.*crontab|.*>\s*\/var\/spool\/cron|.*\/etc\/cron\.(?:d|daily|hourly|weekly|monthly)\/)/i,

	// Permission removal
	chmodZero: /chmod\s+0{3,4}\b/i,

	// Shell injection / Obfuscation
	base64Decode: /base64\s+-d/i,
	base64EncodedShell:
		/(echo|printf)\s+[A-Za-z0-9+/=]{20,}\s*\|\s*base64\s+-d\s*\|\s*(bash|sh|zsh)/i,
	opensslEnc: /openssl\s+enc/i,
	pythonEval: /python\s+-c/i,
	pythonRemoteExec: /python[23]?\s+-c\s+.*(urllib|requests).*exec/i,
	perlEval: /perl\s+-e/i,
	nodeEval: /node\s+-e/i,
	phpEval: /php\s+-r/i,
	rubyEval: /ruby\s+-e/i,
	evalCall: /eval\s*\(+/i,
	execCall: /exec\s*\(+/i,
	powershellDownloadExec: /powershell.*DownloadString.*Invoke-Expression/i,

	// Reverse shells (basic patterns)
	netcatReverse: /nc\s+[\w.-]+\s+\d+\s+-e\s+\/bin\/sh/i,
	altReverseShell:
		/(nc|netcat|bash|sh)\s+.*-e\s*(bash|sh|\/bin\/bash|\/bin\/sh)/i,
	bashReverse: /bash\s+-i\s+>&/i,
	devTcpReverse: /\/dev\/tcp\/[\w.-]+\/\d+/i,
	netcatListener: /\bnc\s+(-l|-p)\s+\d+/i,
	sshTunnel: /ssh\s+.*-[LRD]\s+\d+:/i,
	dockerPrivileged:
		/docker\s+(run|exec).*--privileged(?!=(?:false|f|0))(?:\s+|=(?:true|t|1)(?=\s|$)|\s*$)/i,

	// Fork bombs
	forkBomb: /:(\(|\s+)\)\s*\{\s*:(\s*\|\s*:)?\s*&?\s*;?\s*\}\s*;?\s*:?/i,
};

export const dangerousPatternDescriptions: Record<
	keyof typeof dangerousPatterns,
	string
> = {
	rmRf: "High-risk recursive delete",
	mkfs: "Filesystem formatting",
	diskZero: "Disk zeroing",
	curlPipeShell: "Remote script execution via piped shell",
	bashProcessSubstitution: "Bash process substitution pulling remote content",
	sudoersNopasswd: "Sudoers modification for passwordless sudo",
	systemdService: "Systemd service persistence",
	crontabModification: "Crontab modification for persistence",
	chmodZero: "Permission removal",
	base64Decode: "Base64 decoding (possible obfuscation)",
	base64EncodedShell: "Base64-encoded shell execution",
	opensslEnc: "OpenSSL encryption (possible obfuscation)",
	pythonEval: "Inline Python execution",
	pythonRemoteExec: "Inline Python fetching and exec from network",
	perlEval: "Inline Perl execution",
	nodeEval: "Inline Node.js execution",
	phpEval: "Inline PHP execution",
	rubyEval: "Inline Ruby execution",
	evalCall: "Code evaluation (eval)",
	execCall: "Code execution (exec)",
	powershellDownloadExec: "PowerShell remote download and execution",
	netcatReverse: "Netcat reverse shell",
	altReverseShell: "Reverse shell using shell -e semantics",
	bashReverse: "Bash reverse shell",
	devTcpReverse: "Bash /dev/tcp reverse shell",
	netcatListener: "Netcat listener creation",
	sshTunnel: "SSH tunnel/port forwarding",
	dockerPrivileged: "Privileged Docker execution",
	forkBomb: "Shell fork bomb",
};
