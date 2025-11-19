import { Type } from "@sinclair/typebox";
import { checkGhCliAvailable, executeGhCommand } from "./gh-helpers.js";
import { createTool } from "./tool-dsl.js";

// GitHub Pull Request tool
const ghPrSchema = Type.Object({
	action: Type.Union([
		Type.Literal("create"),
		Type.Literal("checkout"),
		Type.Literal("view"),
		Type.Literal("list"),
		Type.Literal("comment"),
		Type.Literal("checks"),
		Type.Literal("diff"),
	]),
	number: Type.Optional(Type.Number({ minimum: 1 })),
	title: Type.Optional(Type.String({ minLength: 1 })),
	body: Type.Optional(Type.String()),
	branch: Type.Optional(Type.String()),
	base: Type.Optional(Type.String()),
	draft: Type.Optional(Type.Boolean({ default: false })),
	state: Type.Optional(
		Type.Union([
			Type.Literal("open"),
			Type.Literal("closed"),
			Type.Literal("all"),
		]),
	),
	author: Type.Optional(Type.String()),
	label: Type.Optional(Type.Array(Type.String())),
	milestone: Type.Optional(Type.String()),
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, default: 30 })),
	json: Type.Optional(Type.Boolean({ default: false })),
	nameOnly: Type.Optional(Type.Boolean({ default: false })),
});

export const ghPrTool = createTool<typeof ghPrSchema>({
	name: "gh_pr",
	label: "gh pr",
	description: `GitHub pull request operations via gh CLI.

Actions:
  create    - Create PR from current branch (requires: title)
  checkout  - Checkout PR locally (requires: number)
  view      - View PR details (optional: number for specific PR, json for structured output)
  list      - List PRs (filters: state, author, label, milestone, limit)
  comment   - Add comment (requires: number, body)
  checks    - View PR review status and CI checks (requires: number)
  diff      - View PR diff or changed files (requires: number, nameOnly for file list only)

Examples:
  {action: "create", title: "Fix bug", body: "Details", base: "main"}
  {action: "checkout", number: 123}
  {action: "list", state: "open", label: ["bug", "priority"]}
  {action: "list", milestone: "v1.0"}
  {action: "comment", number: 42, body: "LGTM"}
  {action: "checks", number: 42, json: true}
  {action: "diff", number: 42, nameOnly: true}`,
	schema: ghPrSchema,
	async run(params, { signal, respond }) {
		const check = await checkGhCliAvailable(signal);
		if (check) return check;

		const args: string[] = ["pr", params.action];

		if (params.action === "create") {
			if (!params.title) throw new Error("title required for create");
			args.push("--title", params.title);
			if (params.body) args.push("--body", params.body);
			if (params.base) args.push("--base", params.base);
			if (params.draft) args.push("--draft");
		} else if (params.action === "checkout") {
			if (!params.number) throw new Error("number required for checkout");
			args.push(String(params.number));
			if (params.branch) args.push("--branch", params.branch);
		} else if (params.action === "view") {
			if (params.number) args.push(String(params.number));
			if (params.json)
				args.push(
					"--json",
					"title,body,state,number,url,reviewDecision,statusCheckRollup",
				);
		} else if (params.action === "list") {
			if (params.state) args.push("--state", params.state);
			if (params.author) args.push("--author", params.author);
			if (params.label?.length) args.push("--label", params.label.join(","));
			if (params.milestone)
				args.push("--search", `milestone:"${params.milestone}"`);
			if (params.limit) args.push("--limit", String(params.limit));
		} else if (params.action === "comment") {
			if (!params.number || !params.body) {
				throw new Error("number and body required for comment");
			}
			args.push(String(params.number), "--body", params.body);
		} else if (params.action === "checks") {
			if (!params.number) throw new Error("number required for checks");
			args.push(String(params.number));
			if (params.json) {
				args.push(
					"--json",
					"reviewDecision,statusCheckRollup,reviews,latestReviews",
				);
			}
		} else if (params.action === "diff") {
			if (!params.number) throw new Error("number required for diff");
			args.push(String(params.number));
			if (params.nameOnly) args.push("--name-only");
		}

		const cmd = `gh ${args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ")}`;
		return executeGhCommand(`gh-pr-${params.action}`, cmd, signal);
	},
});

// GitHub Issue tool
const ghIssueSchema = Type.Object({
	action: Type.Union([
		Type.Literal("create"),
		Type.Literal("view"),
		Type.Literal("list"),
		Type.Literal("comment"),
		Type.Literal("close"),
	]),
	number: Type.Optional(Type.Number({ minimum: 1 })),
	title: Type.Optional(Type.String({ minLength: 1 })),
	body: Type.Optional(Type.String()),
	labels: Type.Optional(Type.Array(Type.String())),
	state: Type.Optional(
		Type.Union([
			Type.Literal("open"),
			Type.Literal("closed"),
			Type.Literal("all"),
		]),
	),
	author: Type.Optional(Type.String()),
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, default: 30 })),
	json: Type.Optional(Type.Boolean({ default: false })),
});

export const ghIssueTool = createTool<typeof ghIssueSchema>({
	name: "gh_issue",
	label: "gh issue",
	description: `GitHub issue operations via gh CLI.

Actions:
  create   - Create issue (requires: title)
  view     - View issue details (requires: number)
  list     - List issues (filters: state, author, labels, limit)
  comment  - Add comment (requires: number, body)
  close    - Close issue (requires: number)

Examples:
  {action: "create", title: "Bug report", body: "Details", labels: ["bug"]}
  {action: "view", number: 42, json: true}
  {action: "list", state: "open", labels: ["bug", "priority"]}
  {action: "close", number: 42}`,
	schema: ghIssueSchema,
	async run(params, { signal }) {
		const check = await checkGhCliAvailable(signal);
		if (check) return check;

		const args: string[] = ["issue", params.action];

		if (params.action === "create") {
			if (!params.title) throw new Error("title required for create");
			args.push("--title", params.title);
			if (params.body) args.push("--body", params.body);
			if (params.labels?.length) args.push("--label", params.labels.join(","));
		} else if (params.action === "view") {
			if (!params.number) throw new Error("number required for view");
			args.push(String(params.number));
			if (params.json)
				args.push("--json", "title,body,state,number,url,labels");
		} else if (params.action === "list") {
			if (params.state) args.push("--state", params.state);
			if (params.author) args.push("--author", params.author);
			if (params.labels?.length) args.push("--label", params.labels.join(","));
			if (params.limit) args.push("--limit", String(params.limit));
		} else if (params.action === "comment") {
			if (!params.number || !params.body) {
				throw new Error("number and body required for comment");
			}
			args.push(String(params.number), "--body", params.body);
		} else if (params.action === "close") {
			if (!params.number) throw new Error("number required for close");
			args.push(String(params.number));
		}

		const cmd = `gh ${args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ")}`;
		return executeGhCommand(`gh-issue-${params.action}`, cmd, signal);
	},
});

// GitHub Repo tool (simpler, fewer operations)
const ghRepoSchema = Type.Object({
	action: Type.Union([
		Type.Literal("view"),
		Type.Literal("fork"),
		Type.Literal("clone"),
	]),
	repository: Type.Optional(Type.String({ description: "owner/repo format" })),
	directory: Type.Optional(Type.String()),
	json: Type.Optional(Type.Boolean({ default: false })),
});

export const ghRepoTool = createTool<typeof ghRepoSchema>({
	name: "gh_repo",
	label: "gh repo",
	description: `GitHub repository operations via gh CLI.

Actions:
  view   - View current repo info
  fork   - Fork current repo to your account
  clone  - Clone a repo (requires: repository as "owner/repo")

Examples:
  {action: "view", json: true}
  {action: "fork"}
  {action: "clone", repository: "owner/repo", directory: "my-dir"}`,
	schema: ghRepoSchema,
	async run(params, { signal }) {
		const check = await checkGhCliAvailable(signal);
		if (check) return check;

		const args: string[] = ["repo", params.action];

		if (params.action === "view") {
			if (params.json) {
				args.push("--json", "name,description,url,stargazerCount,forkCount");
			}
		} else if (params.action === "clone") {
			if (!params.repository) throw new Error("repository required for clone");
			args.push(params.repository);
			if (params.directory) args.push(params.directory);
		}
		// fork has no additional params

		const cmd = `gh ${args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ")}`;
		return executeGhCommand(`gh-repo-${params.action}`, cmd, signal);
	},
});
