import { readFile } from "node:fs/promises";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import {
	maestroAppServerClientMethods,
	maestroAppServerProtocolModeIds,
	maestroAppServerProtocolVersion,
	maestroAppServerServerMethods,
} from "../../packages/contracts/src/maestro-app-server.js";

describe("app-server schema fixtures", () => {
	it("publishes protocol and payload fixtures for drift review", async () => {
		const protocol = JSON.parse(
			await readFile(
				"packages/contracts/schema/app-server/protocol.json",
				"utf8",
			),
		) as {
			protocolVersion: string;
			clientMethods: string[];
			serverMethods: string[];
			protocolModeIds: string[];
		};
		const payloads = JSON.parse(
			await readFile(
				"packages/contracts/schema/app-server/payload-schemas.json",
				"utf8",
			),
		) as {
			namedSchemas: Record<string, unknown>;
			entrypoints: Record<string, string>;
		};

		expect(protocol.protocolVersion).toBe(maestroAppServerProtocolVersion);
		expect(protocol.clientMethods).toEqual([...maestroAppServerClientMethods]);
		expect(protocol.serverMethods).toEqual([...maestroAppServerServerMethods]);
		expect(protocol.protocolModeIds).toEqual([
			...maestroAppServerProtocolModeIds,
		]);
		expect(payloads.entrypoints).toEqual({
			clientRequest: "MaestroAppServerClientRequestSchema",
			response: "MaestroAppServerResponseSchema",
			serverNotification: "MaestroAppServerServerNotificationSchema",
		});
		expect(payloads.namedSchemas).toHaveProperty(
			"MaestroAppServerProtocolModeListResultSchema",
		);
		expect(payloads.namedSchemas).toHaveProperty(
			"MaestroAppServerRemoteControlDrainResultSchema",
		);
	});

	it("validates app-server JSON-RPC payloads with the generated schemas", async () => {
		const payloads = JSON.parse(
			await readFile(
				"packages/contracts/schema/app-server/payload-schemas.json",
				"utf8",
			),
		) as { namedSchemas: Record<string, unknown> };
		const ajv = new Ajv({ strict: false });
		const validateRequest = ajv.compile(
			payloads.namedSchemas.MaestroAppServerClientRequestSchema,
		);
		const validateResponse = ajv.compile(
			payloads.namedSchemas.MaestroAppServerResponseSchema,
		);
		const validateNotification = ajv.compile(
			payloads.namedSchemas.MaestroAppServerServerNotificationSchema,
		);

		expect(
			validateRequest({
				jsonrpc: "2.0",
				id: "mode-list",
				method: "protocol/mode/list",
			}),
		).toBe(true);
		expect(
			validateResponse({
				jsonrpc: "2.0",
				id: "mode-list",
				result: {
					activeMode: "standard",
					defaultMode: "standard",
					modes: [
						{
							id: "realtime",
							label: "Realtime",
							readOnly: false,
							realtime: true,
							allowedMethods: ["fs/watch"],
							blockedMethods: [],
							serverNotifications: ["fs/changed"],
						},
					],
				},
			}),
		).toBe(true);
		expect(
			validateNotification({
				jsonrpc: "2.0",
				method: "fs/changed",
				params: {
					watchId: "watch_1",
					changedPaths: ["README.md"],
				},
			}),
		).toBe(true);
	});
});
