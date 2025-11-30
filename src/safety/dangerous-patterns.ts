export const dangerousPatterns = {
	// Recursive delete with force
	rmRf: /\brm\s+-[^\n]*-?r[^\n]*-?f[^\n]*\s+(?:-+\w+\s+)*(["']?\/?[\w.*\-\s]*|\.)/i,

	// Filesystem formatting
	mkfs: /\bmkfs\b|\bmkfs\.[a-z0-9]+/i,

	// Disk zeroing
	diskZero: /dd\s+if=\/dev\/(?:zero|null)/i,

	// Permission removal
	chmodZero: /chmod\s+0{3,4}\b/i,

	// Shell injection / Obfuscation
	base64Decode: /base64\s+-d/i,
	opensslEnc: /openssl\s+enc/i,
	pythonEval: /python\s+-c/i,
	perlEval: /perl\s+-e/i,
	nodeEval: /node\s+-e/i,
	phpEval: /php\s+-r/i,
	rubyEval: /ruby\s+-e/i,
	evalCall: /eval\s*\(+/i,
	execCall: /exec\s*\(+/i,

	// Reverse shells (basic patterns)
	netcatReverse: /nc\s+[\w.-]+\s+\d+\s+-e\s+\/bin\/sh/i,
	bashReverse: /bash\s+-i\s+>&/i,
	devTcpReverse: /\/dev\/tcp\/[\w.-]+\/\d+/i,

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
	chmodZero: "Permission removal",
	base64Decode: "Base64 decoding (possible obfuscation)",
	opensslEnc: "OpenSSL encryption (possible obfuscation)",
	pythonEval: "Inline Python execution",
	perlEval: "Inline Perl execution",
	nodeEval: "Inline Node.js execution",
	phpEval: "Inline PHP execution",
	rubyEval: "Inline Ruby execution",
	evalCall: "Code evaluation (eval)",
	execCall: "Code execution (exec)",
	netcatReverse: "Netcat reverse shell",
	bashReverse: "Bash reverse shell",
	devTcpReverse: "Bash /dev/tcp reverse shell",
	forkBomb: "Shell fork bomb",
};
