import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const readJsonBodyMock = vi.fn();
	const sendJsonMock = vi.fn();
	const authenticateJWTMock = vi.fn();
	const findFirstMock = vi.fn();
	const updateMock = vi.fn();
	const setMock = vi.fn();
	const whereMock = vi.fn();
	const returningMock = vi.fn();
	const decryptUserSettingsMock = vi.fn();
	const encryptUserSettingsMock = vi.fn();
	const auditLogMock = vi.fn();

	return {
		readJsonBodyMock,
		sendJsonMock,
		authenticateJWTMock,
		findFirstMock,
		updateMock,
		setMock,
		whereMock,
		returningMock,
		decryptUserSettingsMock,
		encryptUserSettingsMock,
		auditLogMock,
	};
});

vi.mock("../../src/server/server-utils.js", () => ({
	readJsonBody: mocks.readJsonBodyMock,
	sendJson: mocks.sendJsonMock,
}));

vi.mock("../../src/api/enterprise/middleware.js", () => ({
	authenticateJWT: mocks.authenticateJWTMock,
}));

vi.mock("../../src/db/client.js", () => ({
	getDb: () => ({
		query: {
			users: {
				findFirst: mocks.findFirstMock,
			},
		},
		update: mocks.updateMock,
	}),
}));

vi.mock("../../src/db/settings-encryption.js", () => ({
	decryptUserSettings: mocks.decryptUserSettingsMock,
	encryptUserSettings: mocks.encryptUserSettingsMock,
	decryptOrgSettings: vi.fn(),
	encryptOrgSettings: vi.fn(),
}));

vi.mock("../../src/audit/logger.js", () => ({
	AUDIT_ACTIONS: {
		CONFIG_WRITE: "config_write",
	},
	AuditLogger: {
		log: mocks.auditLogMock,
	},
}));

import { createEnterpriseRoutes } from "../../src/api/enterprise-routes.js";

describe.sequential("PUT /api/user/settings", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.authenticateJWTMock.mockResolvedValue({
			userId: "user-1",
			orgId: "org-1",
			roleId: "role-1",
		});
		mocks.decryptUserSettingsMock.mockImplementation((settings) => settings);
		mocks.encryptUserSettingsMock.mockImplementation((settings) => settings);
		mocks.updateMock.mockReturnValue({
			set: mocks.setMock,
		});
		mocks.setMock.mockReturnValue({
			where: mocks.whereMock,
		});
		mocks.whereMock.mockReturnValue({
			returning: mocks.returningMock,
		});
		mocks.returningMock.mockResolvedValue([{ id: "user-1" }]);
	});

	it("rejects non-object JSON bodies before merging settings", async () => {
		mocks.readJsonBodyMock.mockResolvedValue(["bad-patch"]);

		await getHandler()(request("PUT"), {} as ServerResponse);

		expect(mocks.sendJsonMock).toHaveBeenCalledWith(
			expect.anything(),
			400,
			{ error: "Settings body must be an object" },
			{},
			expect.anything(),
		);
		expect(mocks.findFirstMock).not.toHaveBeenCalled();
		expect(mocks.auditLogMock).not.toHaveBeenCalled();
	});

	it("retries with the latest row so concurrent twoFactor writes survive", async () => {
		const concurrentTwoFactor = {
			enabled: true,
			enabledAt: "2026-01-01T00:00:00.000Z",
			secret: "enc:latest",
		};

		mocks.readJsonBodyMock.mockResolvedValue({
			notificationEmail: "new@example.com",
		});
		mocks.findFirstMock
			.mockResolvedValueOnce({
				settings: {
					notificationEmail: "old@example.com",
				},
			})
			.mockResolvedValueOnce({
				settings: {
					notificationEmail: "old@example.com",
					twoFactor: concurrentTwoFactor,
				},
			});
		mocks.returningMock
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ id: "user-1" }]);

		await getHandler()(request("PUT"), {} as ServerResponse);

		expect(mocks.findFirstMock).toHaveBeenCalledTimes(2);
		expect(mocks.encryptUserSettingsMock).toHaveBeenNthCalledWith(1, {
			notificationEmail: "new@example.com",
		});
		expect(mocks.encryptUserSettingsMock).toHaveBeenNthCalledWith(2, {
			notificationEmail: "new@example.com",
			twoFactor: concurrentTwoFactor,
		});
		expect(mocks.auditLogMock).toHaveBeenCalledTimes(1);
		expect(mocks.sendJsonMock).toHaveBeenLastCalledWith(
			expect.anything(),
			200,
			{ success: true },
			{},
			expect.anything(),
		);
	});
});

function getHandler() {
	const route = createEnterpriseRoutes({}).find(
		(candidate) =>
			candidate.method === "PUT" && candidate.path === "/api/user/settings",
	);
	if (!route) {
		throw new Error("PUT /api/user/settings route not found");
	}
	return route.handler;
}

function request(method: string): IncomingMessage {
	return {
		headers: { host: "localhost" },
		method,
		url: "/api/user/settings",
	} as IncomingMessage;
}
