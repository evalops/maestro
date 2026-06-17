import { describe, expect, it } from "vitest";
import { requiredPermissionForSlashCommand } from "../src/slash-permissions.js";

describe("requiredPermissionForSlashCommand", () => {
	it("keeps read-only slash commands ungated by mutation permissions", () => {
		expect(requiredPermissionForSlashCommand("/status", "")).toBeNull();
		expect(requiredPermissionForSlashCommand("/connectors", "")).toBeNull();
		expect(requiredPermissionForSlashCommand("/triggers", "list")).toBeNull();
		expect(requiredPermissionForSlashCommand("/connect", "")).toBeNull();
	});

	it("requires connector write access for connector mutations", () => {
		expect(
			requiredPermissionForSlashCommand("/connect", "github prod"),
		).toEqual({
			action: "execute_tool",
			resource: "connector_*",
		});
		expect(
			requiredPermissionForSlashCommand(
				"/connect-credentials",
				"prod secret-token",
			),
		).toEqual({
			action: "execute_tool",
			resource: "connector_*",
		});
		expect(requiredPermissionForSlashCommand("/disconnect", "prod")).toEqual({
			action: "execute_tool",
			resource: "connector_*",
		});
	});

	it("requires trigger management permission for webhook trigger mutations", () => {
		expect(
			requiredPermissionForSlashCommand(
				"/triggers",
				"add github C123 Review this PR",
			),
		).toEqual({ action: "manage_triggers" });
		expect(
			requiredPermissionForSlashCommand("/triggers", "remove trig_1"),
		).toEqual({ action: "manage_triggers" });
		expect(
			requiredPermissionForSlashCommand("/triggers", "delete trig_1"),
		).toEqual({ action: "manage_triggers" });
	});
});
