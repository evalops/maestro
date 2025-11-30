import * as fs from "node:fs";
import { join } from "node:path";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { resetFirewallConfigCache } from "../../src/config/firewall-config.js";
import {
	type ActionApprovalContext,
	ActionFirewall,
	defaultActionFirewall,
} from "../../src/safety/action-firewall.js";

// Mock process.cwd to return a known path
const MOCK_CWD = "/Users/test/project";
const originalCwd = process.cwd;

// Mock dependencies
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return {
		...actual,
		existsSync: vi.fn(),
		readFileSync: vi.fn(),
	};
});

beforeAll(() => {
	process.cwd = () => MOCK_CWD;
});

afterAll(() => {
	process.cwd = originalCwd;
});

beforeEach(() => {
	resetFirewallConfigCache();
	vi.resetAllMocks();
});

function makeWriteContext(path: string): ActionApprovalContext {
	return { toolName: "write", args: { path } };
}

describe("ActionFirewall - Trusted Paths", () => {
	it("requires approval for path outside workspace by default", async () => {
		// Mock no config
		vi.mocked(fs.existsSync).mockReturnValue(false);

		const verdict = await defaultActionFirewall.evaluate(
			makeWriteContext("/Users/test/external/file.ts"),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("allows writing to configured trusted paths", async () => {
		// Mock config file existence and content
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(
			JSON.stringify({
				containment: {
					trustedPaths: ["/Users/test/external"],
				},
			}),
		);

		const verdict = await defaultActionFirewall.evaluate(
			makeWriteContext("/Users/test/external/file.ts"),
		);
		expect(verdict.action).toBe("allow");
	});

	it("allows writing to subdirectories of trusted paths", async () => {
		// Mock config file
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(
			JSON.stringify({
				containment: {
					trustedPaths: ["/Users/test/external"],
				},
			}),
		);

		const verdict = await defaultActionFirewall.evaluate(
			makeWriteContext("/Users/test/external/subdir/file.ts"),
		);
		expect(verdict.action).toBe("allow");
	});

	it("still blocks paths not in trusted list", async () => {
		// Mock config file
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(
			JSON.stringify({
				containment: {
					trustedPaths: ["/Users/test/external"],
				},
			}),
		);

		const verdict = await defaultActionFirewall.evaluate(
			makeWriteContext("/Users/test/other/file.ts"),
		);
		expect(verdict.action).toBe("require_approval");
	});
});
