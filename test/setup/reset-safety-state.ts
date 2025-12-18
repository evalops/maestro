import { afterEach } from "vitest";
import { resetSafeModeForTests } from "../../src/safety/safe-mode.js";

const envKeysToClear = [
	"COMPOSER_SAFE_MODE",
	"COMPOSER_SAFE_REQUIRE_PLAN",
	"COMPOSER_SAFE_VALIDATORS",
	"COMPOSER_SAFE_LSP_SEVERITY",
	"COMPOSER_PLAN_MODE",
];

afterEach(() => {
	for (const key of envKeysToClear) {
		Reflect.deleteProperty(process.env, key);
	}
	resetSafeModeForTests();
});
