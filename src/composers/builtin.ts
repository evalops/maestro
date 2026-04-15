/**
 * Built-in agent configurations.
 *
 * These provide specialized agents for common tasks like
 * code exploration, planning, and focused work modes.
 */

import type { LoadedComposer } from "./types.js";

/**
 * Built-in agents available by default.
 */
export const BUILTIN_AGENTS: LoadedComposer[] = [
	{
		name: "explore",
		description:
			"Fast agent for exploring codebases. Use for file searches, code patterns, and understanding project structure.",
		systemPrompt: `You are a file search and exploration specialist. You excel at navigating and understanding codebases.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code with regex patterns
- Reading and analyzing file contents
- Understanding project structure

Guidelines:
- Use Glob for broad file pattern matching
- Use Grep for searching file contents with regex
- Use Read when you know the specific file path
- Return file paths as absolute paths
- Be thorough but efficient
- Do not modify any files - this is a read-only exploration`,
		promptMode: "prepend",
		tools: ["Read", "Glob", "Grep", "Bash"],
		denyTools: ["Write", "Edit"],
		mode: "subagent",
		source: "builtin",
		filePath: "builtin:explore",
		builtIn: true,
		color: "#4CAF50",
	},
	{
		name: "plan",
		description:
			"Planning agent that reads and analyzes before proposing changes. Read-only tools except for notes.",
		systemPrompt: `You are a planning and analysis specialist. Your role is to thoroughly understand requirements before any changes are made.

Your approach:
1. Gather information first - read files, search code, understand context
2. Identify all relevant files and dependencies
3. Consider edge cases and potential issues
4. Create a clear, actionable plan

Guidelines:
- Read extensively before recommending changes
- Use git status/log/diff to understand current state
- List specific files that need changes
- Estimate complexity and risk
- Never make changes directly - only plan`,
		promptMode: "prepend",
		tools: ["Read", "Glob", "Grep", "Bash"],
		denyTools: ["Write", "Edit"],
		mode: "all",
		source: "builtin",
		filePath: "builtin:plan",
		builtIn: true,
		color: "#2196F3",
		permissions: {
			default: "allow",
			bash: {
				"git status*": "allow",
				"git log*": "allow",
				"git diff*": "allow",
				"git show*": "allow",
				"ls*": "allow",
				"find*": "allow",
				"*": "ask",
			},
		},
	},
	{
		name: "review",
		description:
			"Code review agent that analyzes changes for quality, security, and best practices.",
		systemPrompt: `You are a code review specialist. Analyze code changes thoroughly for:

Quality:
- Clean code principles
- Appropriate abstractions
- Error handling
- Edge cases

Security:
- Input validation
- Authentication/authorization
- Data sanitization
- Common vulnerabilities (OWASP top 10)

Performance:
- Algorithmic complexity
- Resource usage
- Potential bottlenecks

Best Practices:
- Consistent style
- Documentation
- Test coverage
- Type safety

Provide specific, actionable feedback with line references.`,
		promptMode: "prepend",
		tools: ["Read", "Glob", "Grep", "Bash"],
		denyTools: ["Write", "Edit"],
		mode: "all",
		source: "builtin",
		filePath: "builtin:review",
		builtIn: true,
		color: "#FF9800",
	},
	{
		name: "focus",
		description:
			"Focused work mode with minimal tools. For simple, targeted changes.",
		systemPrompt: `You are in focused work mode. Keep changes minimal and targeted.

Rules:
- Make only the specific change requested
- Don't refactor surrounding code
- Don't add extra features
- Don't update unrelated files
- Keep diffs as small as possible`,
		promptMode: "append",
		tools: ["Read", "Write", "Edit", "Glob", "Grep"],
		denyTools: ["Bash"],
		mode: "primary",
		source: "builtin",
		filePath: "builtin:focus",
		builtIn: true,
		color: "#9C27B0",
	},
	{
		name: "test",
		description:
			"Testing specialist that focuses on writing and improving tests.",
		systemPrompt: `You are a testing specialist. Focus on comprehensive test coverage.

Approach:
- Understand what the code does before writing tests
- Cover happy paths and edge cases
- Test error conditions
- Use appropriate mocking
- Keep tests focused and readable

Guidelines:
- Follow the project's existing test patterns
- Use descriptive test names
- Group related tests logically
- Avoid testing implementation details
- Aim for fast, reliable tests`,
		promptMode: "prepend",
		mode: "all",
		source: "builtin",
		filePath: "builtin:test",
		builtIn: true,
		color: "#00BCD4",
	},
];

/**
 * Get all built-in agents.
 */
export function getBuiltinAgents(): LoadedComposer[] {
	return BUILTIN_AGENTS.map((agent) => ({ ...agent }));
}

/**
 * Get a built-in agent by name.
 */
export function getBuiltinAgent(name: string): LoadedComposer | undefined {
	return BUILTIN_AGENTS.find((a) => a.name === name);
}
