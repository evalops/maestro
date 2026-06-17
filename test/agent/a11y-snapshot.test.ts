import { describe, expect, it } from "vitest";
import {
	A11Y_SNAPSHOT_VERSION,
	type A11yNodeInput,
	buildSnapshot,
	findByRole,
	isStaleRef,
	listRefs,
	renderCompact,
	resolveRef,
} from "../../src/agent/a11y-snapshot.js";

function makeTree(): A11yNodeInput {
	return {
		role: "main",
		children: [
			{ role: "heading", name: "Welcome back" },
			{
				role: "form",
				children: [
					{ role: "textbox", name: "Email", value: "" },
					{ role: "textbox", name: "Password", value: "" },
					{
						role: "checkbox",
						name: "Remember me",
						state: { checked: false },
					},
					{ role: "button", name: "Submit" },
				],
			},
			{ role: "link", name: "Forgot password?", href: "/forgot" },
		],
	};
}

describe("agent/a11y-snapshot", () => {
	describe("buildSnapshot", () => {
		it("returns a snapshot with the configured version + capture metadata", () => {
			const snap = buildSnapshot(makeTree(), {
				url: "https://example.com/login",
				title: "Login",
				capturedAt: "2026-06-15T19:00:00.000Z",
				mutationCounter: 7,
			});
			expect(snap.version).toBe(A11Y_SNAPSHOT_VERSION);
			expect(snap.url).toBe("https://example.com/login");
			expect(snap.title).toBe("Login");
			expect(snap.capturedAt).toBe("2026-06-15T19:00:00.000Z");
			expect(snap.mutationCounter).toBe(7);
		});

		it("assigns @eN refs to interactive nodes in pre-order", () => {
			const snap = buildSnapshot(makeTree(), {
				url: "https://example.com/login",
			});
			const refs = listRefs(snap);
			expect(refs).toEqual(["@e1", "@e2", "@e3", "@e4", "@e5"]);
			expect(resolveRef(snap, "@e1")?.role).toBe("textbox");
			expect(resolveRef(snap, "@e1")?.name).toBe("Email");
			expect(resolveRef(snap, "@e4")?.role).toBe("button");
			expect(resolveRef(snap, "@e5")?.role).toBe("link");
		});

		it("assigns parent refs before nested interactive descendants", () => {
			const snap = buildSnapshot(
				{
					role: "main",
					children: [
						{
							role: "group",
							name: "Toolbar",
							children: [{ role: "button", name: "Save" }],
						},
					],
				},
				{
					url: "https://example.com/login",
					allocate: {
						isInteractive: (node) =>
							node.role === "group" || node.role === "button",
					},
				},
			);

			expect(listRefs(snap)).toEqual(["@e1", "@e2"]);
			expect(resolveRef(snap, "@e1")?.role).toBe("group");
			expect(resolveRef(snap, "@e2")?.role).toBe("button");
		});

		it("does not ref informational nodes (heading, form, main)", () => {
			const snap = buildSnapshot(makeTree(), {
				url: "https://example.com/login",
			});
			// `main`, `heading`, and `form` are not in the interactive role set
			// so they get no `@eN` ref.
			expect(snap.root.ref).toBeUndefined();
			expect(snap.root.children[0]?.ref).toBeUndefined(); // heading
			expect(snap.root.children[1]?.ref).toBeUndefined(); // form
		});

		it("respects a custom `isInteractive` predicate", () => {
			const snap = buildSnapshot(makeTree(), {
				url: "https://example.com/login",
				allocate: {
					isInteractive: (n) => n.role === "heading",
				},
			});
			expect(listRefs(snap)).toEqual(["@e1"]);
			expect(resolveRef(snap, "@e1")?.role).toBe("heading");
		});

		it("starts allocation at a configurable index", () => {
			const snap = buildSnapshot(makeTree(), {
				url: "https://example.com/login",
				allocate: { startIndex: 100 },
			});
			expect(listRefs(snap)[0]).toBe("@e100");
		});

		it("defaults capturedAt to the current time when omitted", () => {
			const snap = buildSnapshot(makeTree(), {
				url: "https://example.com/login",
			});
			expect(() => new Date(snap.capturedAt).toISOString()).not.toThrow();
		});
	});

	describe("resolveRef + isStaleRef", () => {
		it("returns undefined for refs not in the snapshot and flags them stale", () => {
			const snap = buildSnapshot(makeTree(), {
				url: "https://example.com/login",
			});
			expect(resolveRef(snap, "@e999")).toBeUndefined();
			expect(isStaleRef(snap, "@e999")).toBe(true);
			expect(isStaleRef(snap, "@e1")).toBe(false);
		});
	});

	describe("findByRole", () => {
		it("returns the first matching node (pre-order)", () => {
			const snap = buildSnapshot(makeTree(), {
				url: "https://example.com/login",
			});
			const button = findByRole(snap, "button");
			expect(button?.name).toBe("Submit");
		});

		it("supports exact case-insensitive name match", () => {
			const snap = buildSnapshot(makeTree(), {
				url: "https://example.com/login",
			});
			const textbox = findByRole(snap, "textbox", { name: "password" });
			expect(textbox?.name).toBe("Password");
		});

		it("supports substring (nameContains) match", () => {
			const snap = buildSnapshot(makeTree(), {
				url: "https://example.com/login",
			});
			const link = findByRole(snap, "link", { nameContains: "forgot" });
			expect(link?.href).toBe("/forgot");
		});

		it("returns undefined when no node matches", () => {
			const snap = buildSnapshot(makeTree(), {
				url: "https://example.com/login",
			});
			expect(findByRole(snap, "button", { name: "logout" })).toBeUndefined();
			expect(findByRole(snap, "table")).toBeUndefined();
		});
	});

	describe("renderCompact", () => {
		it("renders ref-tagged interactive nodes and indents by depth", () => {
			const snap = buildSnapshot(makeTree(), {
				url: "https://example.com/login",
			});
			const out = renderCompact(snap);
			const lines = out.split("\n");
			expect(lines[0]).toBe("main");
			expect(lines[1]).toBe(`  heading "Welcome back"`);
			expect(lines).toContain(`    @e1 textbox "Email"`);
			expect(lines).toContain(`    @e3 checkbox "Remember me" [unchecked]`);
			expect(lines).toContain(`    @e4 button "Submit"`);
		});

		it("optionally includes hrefs on link nodes", () => {
			const snap = buildSnapshot(makeTree(), {
				url: "https://example.com/login",
			});
			const out = renderCompact(snap, { includeHrefs: true });
			expect(out).toContain(`@e5 link "Forgot password?" href="/forgot"`);
		});

		it("renders state flags in brackets", () => {
			const tree: A11yNodeInput = {
				role: "main",
				children: [
					{
						role: "checkbox",
						name: "Subscribe",
						state: { checked: true, required: true },
					},
					{
						role: "button",
						name: "Send",
						state: { disabled: true },
					},
					{
						role: "checkbox",
						name: "Mixed",
						state: { checked: "mixed" },
					},
					{
						role: "switch",
						name: "Airplane mode",
						state: { pressed: false },
					},
					{
						role: "tab",
						name: "Settings",
						state: { selected: false },
					},
				],
			};
			const snap = buildSnapshot(tree, { url: "https://example.com" });
			const out = renderCompact(snap);
			expect(out).toContain(`@e1 checkbox "Subscribe" [required checked]`);
			expect(out).toContain(`@e2 button "Send" [disabled]`);
			expect(out).toContain(`@e3 checkbox "Mixed" [checked=mixed]`);
			expect(out).toContain(`@e4 switch "Airplane mode" [unpressed]`);
			expect(out).toContain(`@e5 tab "Settings" [unselected]`);
		});

		it("caps render depth via maxDepth", () => {
			const snap = buildSnapshot(makeTree(), {
				url: "https://example.com/login",
			});
			const out = renderCompact(snap, { maxDepth: 1 });
			// `main` (depth 0), then the three direct children (depth 1).
			// No textboxes/checkbox/button under `form` (those are depth 2).
			expect(out).not.toContain("textbox");
			expect(out).not.toContain("button");
			expect(out).toContain("form");
		});
	});
});
