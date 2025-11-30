export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface Sandbox {
	/**
	 * Execute a command in the sandbox.
	 * @param command The command string to execute
	 * @param cwd The working directory relative to the sandbox root (or absolute if allowed)
	 * @param env Environment variables to set
	 */
	exec(
		command: string,
		cwd?: string,
		env?: Record<string, string>,
	): Promise<ExecResult>;

	/**
	 * Read a file from the sandbox.
	 * @param path Path to the file
	 */
	readFile(path: string): Promise<string>;

	/**
	 * Write a file to the sandbox.
	 * @param path Path to the file
	 * @param content Content to write
	 */
	writeFile(path: string, content: string): Promise<void>;

	/**
	 * Check if a file exists.
	 * @param path Path to the file
	 */
	exists(path: string): Promise<boolean>;

	/**
	 * Clean up sandbox resources (stop containers, etc.)
	 */
	dispose(): Promise<void>;
}
