import { describe, expect, it, vi } from "vitest";
import { ghIssueTool, ghPrTool, ghRepoTool } from "../../src/tools/gh.js";

// Mock the gh-helpers module to avoid needing actual gh CLI
vi.mock("../../src/tools/gh-helpers.js", () => ({
	checkGhCliAvailable: vi.fn().mockResolvedValue(null),
	executeGhCommand: vi.fn().mockImplementation((_id, cmd) => ({
		content: [{ type: "text", text: `Executed: ${cmd}` }],
		isError: false,
		details: { command: cmd },
	})),
}));

describe("gh PR tool", () => {
	describe("parameter validation", () => {
		it("requires title for create action", async () => {
			await expect(
				ghPrTool.execute("gh-pr-1", {
					action: "create",
				}),
			).rejects.toThrow("title required for create");
		});

		it("requires number for checkout action", async () => {
			await expect(
				ghPrTool.execute("gh-pr-2", {
					action: "checkout",
				}),
			).rejects.toThrow("number required for checkout");
		});

		it("requires number and body for comment action", async () => {
			await expect(
				ghPrTool.execute("gh-pr-3", {
					action: "comment",
					number: 42,
				}),
			).rejects.toThrow("number and body required for comment");

			await expect(
				ghPrTool.execute("gh-pr-4", {
					action: "comment",
					body: "test",
				}),
			).rejects.toThrow("number and body required for comment");
		});

		it("requires number for checks action", async () => {
			await expect(
				ghPrTool.execute("gh-pr-5", {
					action: "checks",
				}),
			).rejects.toThrow("number required for checks");
		});

		it("requires number for diff action", async () => {
			await expect(
				ghPrTool.execute("gh-pr-6", {
					action: "diff",
				}),
			).rejects.toThrow("number required for diff");
		});
	});

	describe("command building", () => {
		it("builds create command with options", async () => {
			const result = await ghPrTool.execute("gh-pr-7", {
				action: "create",
				title: "My PR",
				body: "Description",
				base: "main",
				draft: true,
			});

			const text = result.content?.[0];
			expect(text).toBeDefined();
			if (text && "text" in text) {
				expect(text.text).toContain("pr");
				expect(text.text).toContain("create");
				expect(text.text).toContain("My PR");
				expect(text.text).toContain("Description");
				expect(text.text).toContain("main");
				expect(text.text).toContain("draft");
			}
		});

		it("builds checkout command", async () => {
			const result = await ghPrTool.execute("gh-pr-8", {
				action: "checkout",
				number: 123,
				branch: "feature",
			});

			const text = result.content?.[0];
			expect(text).toBeDefined();
			if (text && "text" in text) {
				expect(text.text).toContain("checkout");
				expect(text.text).toContain("123");
				expect(text.text).toContain("feature");
			}
		});

		it("builds view command with json", async () => {
			const result = await ghPrTool.execute("gh-pr-9", {
				action: "view",
				number: 42,
				json: true,
			});

			const text = result.content?.[0];
			expect(text).toBeDefined();
			if (text && "text" in text) {
				expect(text.text).toContain("view");
				expect(text.text).toContain("42");
				expect(text.text).toContain("json");
			}
		});

		it("builds list command with filters", async () => {
			const result = await ghPrTool.execute("gh-pr-10", {
				action: "list",
				state: "open",
				author: "testuser",
				label: ["bug", "priority"],
				limit: 50,
			});

			const text = result.content?.[0];
			expect(text).toBeDefined();
			if (text && "text" in text) {
				expect(text.text).toContain("list");
				expect(text.text).toContain("open");
				expect(text.text).toContain("testuser");
				expect(text.text).toContain("bug,priority");
				expect(text.text).toContain("50");
			}
		});

		it("builds diff command with nameOnly", async () => {
			const result = await ghPrTool.execute("gh-pr-11", {
				action: "diff",
				number: 42,
				nameOnly: true,
			});

			const text = result.content?.[0];
			expect(text).toBeDefined();
			if (text && "text" in text) {
				expect(text.text).toContain("diff");
				expect(text.text).toContain("42");
				expect(text.text).toContain("name-only");
			}
		});
	});
});

describe("gh Issue tool", () => {
	describe("parameter validation", () => {
		it("requires title for create action", async () => {
			await expect(
				ghIssueTool.execute("gh-issue-1", {
					action: "create",
				}),
			).rejects.toThrow("title required for create");
		});

		it("requires number for view action", async () => {
			await expect(
				ghIssueTool.execute("gh-issue-2", {
					action: "view",
				}),
			).rejects.toThrow("number required for view");
		});

		it("requires number and body for comment action", async () => {
			await expect(
				ghIssueTool.execute("gh-issue-3", {
					action: "comment",
					number: 42,
				}),
			).rejects.toThrow("number and body required");
		});

		it("requires number for close action", async () => {
			await expect(
				ghIssueTool.execute("gh-issue-4", {
					action: "close",
				}),
			).rejects.toThrow("number required for close");
		});
	});

	describe("command building", () => {
		it("builds create command with labels", async () => {
			const result = await ghIssueTool.execute("gh-issue-5", {
				action: "create",
				title: "Bug report",
				body: "Details",
				labels: ["bug", "critical"],
			});

			const text = result.content?.[0];
			expect(text).toBeDefined();
			if (text && "text" in text) {
				expect(text.text).toContain("issue");
				expect(text.text).toContain("create");
				expect(text.text).toContain("Bug report");
				expect(text.text).toContain("bug,critical");
			}
		});

		it("builds list command with filters", async () => {
			const result = await ghIssueTool.execute("gh-issue-6", {
				action: "list",
				state: "closed",
				author: "testuser",
				labels: ["enhancement"],
				limit: 25,
			});

			const text = result.content?.[0];
			expect(text).toBeDefined();
			if (text && "text" in text) {
				expect(text.text).toContain("list");
				expect(text.text).toContain("closed");
				expect(text.text).toContain("testuser");
				expect(text.text).toContain("enhancement");
				expect(text.text).toContain("25");
			}
		});
	});
});

describe("gh Repo tool", () => {
	describe("parameter validation", () => {
		it("requires repository for clone action", async () => {
			await expect(
				ghRepoTool.execute("gh-repo-1", {
					action: "clone",
				}),
			).rejects.toThrow("repository required for clone");
		});
	});

	describe("command building", () => {
		it("builds view command with json", async () => {
			const result = await ghRepoTool.execute("gh-repo-2", {
				action: "view",
				json: true,
			});

			const text = result.content?.[0];
			expect(text).toBeDefined();
			if (text && "text" in text) {
				expect(text.text).toContain("repo");
				expect(text.text).toContain("view");
				expect(text.text).toContain("json");
			}
		});

		it("builds clone command with directory", async () => {
			const result = await ghRepoTool.execute("gh-repo-3", {
				action: "clone",
				repository: "owner/repo",
				directory: "my-dir",
			});

			const text = result.content?.[0];
			expect(text).toBeDefined();
			if (text && "text" in text) {
				expect(text.text).toContain("clone");
				expect(text.text).toContain("owner/repo");
				expect(text.text).toContain("my-dir");
			}
		});

		it("builds fork command", async () => {
			const result = await ghRepoTool.execute("gh-repo-4", {
				action: "fork",
			});

			expect(result.isError).toBeFalsy();
			const text = result.content?.[0];
			expect(text).toBeDefined();
			if (text && "text" in text) {
				expect(text.text).toContain("fork");
			}
		});
	});
});
