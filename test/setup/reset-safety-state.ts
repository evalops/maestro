import { afterEach } from "vitest";
import { resetSafeModeForTests } from "../../src/safety/safe-mode.js";

const envKeysToClear = [
	"MAESTRO_SAFE_MODE",
	"MAESTRO_SAFE_REQUIRE_PLAN",
	"MAESTRO_SAFE_VALIDATORS",
	"MAESTRO_SAFE_LSP_SEVERITY",
	"MAESTRO_PLAN_MODE",
];

afterEach(() => {
	for (const key of envKeysToClear) {
		Reflect.deleteProperty(process.env, key);
	}
	resetSafeModeForTests();
});
