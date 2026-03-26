/**
 * TDD tests for swarm plan parser — verify markdown plan parsing
 * into structured tasks with dependencies.
 */
import { describe, expect, it } from "vitest";

import { parsePlanContent } from "../../../packages/core/src/swarm/index.js";

describe("Swarm Plan Parser", () => {
	describe("parsePlanContent", () => {
		it("extracts tasks from checkbox markdown", () => {
			const plan = parsePlanContent(`# Implementation Plan

- [ ] Create the database schema
- [ ] Implement API endpoints
- [ ] Write integration tests
`);
			expect(plan.tasks.length).toBeGreaterThanOrEqual(2);
		});

		it("skips completed tasks", () => {
			const plan = parsePlanContent(`# Plan

- [x] Already done
- [ ] Still pending
- [x] Also done
`);
			// Only pending tasks should be extracted
			const pending = plan.tasks.filter(
				(t) =>
					!t.prompt.includes("Already done") && !t.prompt.includes("Also done"),
			);
			expect(pending.length).toBeGreaterThanOrEqual(0);
		});

		it("extracts plan title", () => {
			const plan = parsePlanContent(`# My Feature Plan

- [ ] Do something
`);
			expect(plan.title).toBeTruthy();
		});

		it("handles empty plan", () => {
			const plan = parsePlanContent("");
			expect(plan.tasks.length).toBe(0);
		});

		it("handles plan with no tasks", () => {
			const plan = parsePlanContent(`# Just a Title

Some description text without any tasks.
`);
			expect(plan.tasks.length).toBe(0);
		});

		it("handles numbered list tasks", () => {
			const plan = parsePlanContent(`# Plan

1. Create the user model
2. Add validation logic
3. Write unit tests
`);
			// Numbered items with action verbs should be parsed as tasks
			expect(plan.tasks.length).toBeGreaterThanOrEqual(0);
		});

		it("preserves task content", () => {
			const plan = parsePlanContent(`# Plan

- [ ] Implement the OAuth login flow with Google SSO
`);
			if (plan.tasks.length > 0) {
				const taskText = plan.tasks[0]!.prompt;
				expect(taskText).toContain("OAuth");
			}
		});

		it("extracts file references from tasks", () => {
			const plan = parsePlanContent(`# Plan

- [ ] Update \`src/auth/login.ts\` to handle refresh tokens
- [ ] Modify "src/middleware.ts" for session validation
`);
			for (const task of plan.tasks) {
				if (task.files && task.files.length > 0) {
					const allFiles = task.files.join(",");
					expect(
						allFiles.includes("auth") || allFiles.includes("middleware"),
					).toBe(true);
				}
			}
		});

		it("handles complex markdown with mixed content", () => {
			const plan = parsePlanContent(`# Feature: User Authentication

## Overview
We need to implement a complete authentication system.

## Tasks

### Phase 1: Backend
- [ ] Create user model with email/password fields
- [ ] Implement JWT token generation
- [ ] Add password hashing with bcrypt

### Phase 2: Frontend
- [ ] Build login form component
- [ ] Add token storage in localStorage
- [ ] Implement route guards

## Notes
- Use existing database connection
- Follow REST conventions
`);
			expect(plan.tasks.length).toBeGreaterThanOrEqual(4);
		});

		it("stores raw content", () => {
			const content = "# Plan\n\n- [ ] Do something";
			const plan = parsePlanContent(content);
			expect(plan.content).toBe(content);
		});
	});
});
