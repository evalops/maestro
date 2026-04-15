// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../packages/web/src/components/composer-mcp-elicitation.js";

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("composer-mcp-elicitation", () => {
	it("renders form mode and emits structured accept responses", async () => {
		const el = document.createElement(
			"composer-mcp-elicitation",
		) as HTMLElement & {
			queueLength: number;
			request: {
				toolCallId: string;
				toolName: string;
				kind: "mcp_elicitation";
				args: Record<string, unknown>;
			};
			updateComplete?: Promise<void>;
		};

		el.request = {
			toolCallId: "mcp-call-1",
			toolName: "mcp_elicitation",
			kind: "mcp_elicitation",
			args: {
				serverName: "context7",
				requestId: "request-1",
				mode: "form",
				message: "Provide the project details",
				requestedSchema: {
					type: "object",
					properties: {
						project: { type: "string", title: "Project" },
						approved: { type: "boolean", title: "Approved", default: true },
						count: { type: "integer", title: "Count", default: 2 },
						flavor: {
							type: "string",
							title: "Flavor",
							enum: ["vanilla", "chocolate"],
							default: "vanilla",
						},
						tags: {
							type: "array",
							title: "Tags",
							items: { enum: ["alpha", "beta"] },
							default: ["alpha"],
						},
					},
					required: ["project", "flavor"],
				},
			},
		};
		el.queueLength = 2;

		const submit = vi.fn();
		el.addEventListener("submit-response", submit as EventListener);

		document.body.appendChild(el);
		await el.updateComplete;

		const text = (el.shadowRoot?.textContent ?? "").replace(/\s+/g, " ");
		expect(text).toContain("MCP Elicitation");
		expect(text).toContain("Request 1 of 2");
		expect(text).toContain("Provide the project details");

		const projectInput = el.shadowRoot?.querySelector(
			'input[data-field-key="project"]',
		) as HTMLInputElement | null;
		expect(projectInput).not.toBeNull();
		projectInput!.value = "Maestro";
		projectInput!.dispatchEvent(new Event("input"));

		const submitButton = el.shadowRoot?.querySelector(
			".btn-accept",
		) as HTMLButtonElement | null;
		submitButton?.click();

		expect(submit).toHaveBeenCalledTimes(1);
		expect(submit.mock.calls[0]?.[0]).toMatchObject({
			detail: {
				toolCallId: "mcp-call-1",
				action: "accept",
				content: {
					project: "Maestro",
					approved: true,
					count: 2,
					flavor: "vanilla",
					tags: ["alpha"],
				},
			},
		});
	});

	it("opens URL mode and emits an accept response without content", async () => {
		const openSpy = vi.fn();
		Object.defineProperty(window, "open", {
			configurable: true,
			value: openSpy,
		});

		const el = document.createElement(
			"composer-mcp-elicitation",
		) as HTMLElement & {
			request: {
				toolCallId: string;
				toolName: string;
				kind: "mcp_elicitation";
				args: Record<string, unknown>;
			};
			updateComplete?: Promise<void>;
		};

		el.request = {
			toolCallId: "mcp-call-2",
			toolName: "mcp_elicitation",
			kind: "mcp_elicitation",
			args: {
				serverName: "github",
				requestId: "request-2",
				mode: "url",
				message: "Authorize GitHub access",
				url: "https://example.com/authorize",
				elicitationId: "elicit-2",
			},
		};

		const submit = vi.fn();
		el.addEventListener("submit-response", submit as EventListener);
		document.body.appendChild(el);
		await el.updateComplete;

		const acceptButton = el.shadowRoot?.querySelector(
			".btn-accept",
		) as HTMLButtonElement | null;
		acceptButton?.click();

		expect(openSpy).toHaveBeenCalledWith(
			"https://example.com/authorize",
			"_blank",
			"noopener,noreferrer",
		);
		expect(submit).toHaveBeenCalledTimes(1);
		expect(submit.mock.calls[0]?.[0]).toMatchObject({
			detail: {
				toolCallId: "mcp-call-2",
				action: "accept",
			},
		});
		expect(submit.mock.calls[0]?.[0].detail).not.toHaveProperty("content");
	});
});
