import {
	chmodSync,
	existsSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { writeTool } from "../src/tools/write.js";
import { editTool } from "../src/tools/edit.js";
import { todoTool } from "../src/tools/todo.js";
import {
	configureSafeMode,
	resetSafeModeForTests,
	setPlanSatisfied,
} from "../src/safety/safe-mode.js";

const TEST_DIR = join(process.cwd(), "tmp", "safe-mode-tests");

function setSafeModeEnv(validators?: string) {
	process.env.COMPOSER_SAFE_MODE = "1";
	process.env.COMPOSER_SAFE_REQUIRE_PLAN = "1";
	if (validators) {
		process.env.COMPOSER_SAFE_VALIDATORS = validators;
	} else {
		delete process.env.COMPOSER_SAFE_VALIDATORS;
	}
	configureSafeMode(true);
}

describe("Safe mode", () => {
	beforeEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
		mkdirSync(TEST_DIR, { recursive: true });
		resetSafeModeForTests();
		delete process.env.COMPOSER_SAFE_MODE;
		delete process.env.COMPOSER_SAFE_REQUIRE_PLAN;
		delete process.env.COMPOSER_SAFE_VALIDATORS;
	});

	it("blocks write/edit until todo plan recorded", async () => {
		setSafeModeEnv();

		await expect(
			writeTool.execute("write-test", {
				path: join(TEST_DIR, "file.txt"),
				content: "hello",
			}),
		).rejects.toThrow(/requires a plan/);

		await todoTool.execute("todo-plan", {
			goal: "Safe mode test",
			items: [{ content: "plan" }],
		});

		await expect(
			writeTool.execute("write-test", {
				path: join(TEST_DIR, "file.txt"),
				content: "hello",
			}),
		).resolves.toBeDefined();

		await expect(
			editTool.execute("edit-test", {
				path: join(TEST_DIR, "file.txt"),
				oldText: "hello",
				newText: "world",
			}),
		).resolves.toBeDefined();
	});

	it("runs validators and rolls back on failure", async () => {
		const script = join(TEST_DIR, "validator.sh");
		writeFileSync(script, "#!/bin/sh\nexit 1\n");
		chmodSync(script, 0o755);
		setSafeModeEnv(`sh ${script}`);
		setPlanSatisfied(true);

		await expect(
			writeTool.execute("write-validator", {
				path: join(TEST_DIR, "file.txt"),
				content: "hello",
			}),
		).rejects.toThrow(/Validator failed/);
		expect(existsSync(join(TEST_DIR, "file.txt"))).toBe(false);

		const successScript = join(TEST_DIR, "validator-success.sh");
		writeFileSync(successScript, "#!/bin/sh\necho ok\n");
		chmodSync(successScript, 0o755);
		setSafeModeEnv(`sh ${successScript}`);
		setPlanSatisfied(true);

		const result = await writeTool.execute("write-success", {
			path: join(TEST_DIR, "file.txt"),
			content: "hello",
		});
		expect(result.details?.validators?.[0]?.stdout).toContain("ok");
	});
});
