import { describe, expect, it } from "vitest";
import { resolveVarRefs } from "../../src/theme/color-utils.js";
import { embeddedThemes } from "../../src/theme/embedded-themes.js";
import { validateThemeJson } from "../../src/theme/theme-schema.js";

describe("embeddedThemes", () => {
	const themeNames = ["dark", "light", "high-contrast"] as const;

	for (const name of themeNames) {
		describe(`${name} theme`, () => {
			const theme = embeddedThemes[name];

			it("passes schema validation", () => {
				expect(validateThemeJson.Check(theme)).toBe(true);
			});

			it("has all required color keys", () => {
				const requiredColors = [
					"accent",
					"accentWarm",
					"border",
					"borderAccent",
					"borderMuted",
					"success",
					"error",
					"warning",
					"muted",
					"dim",
					"text",
					"userMessageBg",
					"userMessageText",
					"toolPendingBg",
					"toolSuccessBg",
					"toolErrorBg",
					"toolTitle",
					"toolOutput",
					"mdHeading",
					"mdLink",
					"mdLinkUrl",
					"mdCode",
					"mdCodeBlock",
					"mdCodeBlockBorder",
					"mdQuote",
					"mdQuoteBorder",
					"mdHr",
					"mdListBullet",
					"toolDiffAdded",
					"toolDiffRemoved",
					"toolDiffContext",
					"syntaxComment",
					"syntaxKeyword",
					"syntaxFunction",
					"syntaxVariable",
					"syntaxString",
					"syntaxNumber",
					"syntaxType",
					"syntaxOperator",
					"syntaxPunctuation",
					"thinkingOff",
					"thinkingMinimal",
					"thinkingLow",
					"thinkingMedium",
					"thinkingHigh",
				];
				for (const key of requiredColors) {
					expect(theme.colors).toHaveProperty(key);
				}
			});

			it("resolves all var references without errors", () => {
				const vars = theme.vars ?? {};
				for (const [, value] of Object.entries(theme.colors)) {
					expect(() => resolveVarRefs(value, vars)).not.toThrow();
				}
			});
		});
	}
});
