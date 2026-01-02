import {
	BUILT_IN_PII_PATTERNS,
	PiiDetector,
} from "../../security/pii-detector.js";
import { isHelpRequest } from "./grouped/utils.js";
import type { CommandExecutionContext } from "./types.js";

const PII_USAGE = [
	"PII detection:",
	"  /pii patterns        List built-in patterns",
	"  /pii test <text>     Detect and redact sample text",
	"  /pii help            Show this help",
].join("\n");

export function handlePiiCommand(context: CommandExecutionContext): void {
	const args = context.argumentText.trim().split(/\s+/).filter(Boolean);
	const subcommand = (args[0] || "").toLowerCase();

	if (!subcommand || isHelpRequest(subcommand)) {
		context.showInfo(PII_USAGE);
		return;
	}

	switch (subcommand) {
		case "patterns":
		case "list": {
			const lines = ["Built-in PII patterns:"];
			for (const pattern of BUILT_IN_PII_PATTERNS) {
				lines.push(
					`  - ${pattern.name}: ${pattern.description} (${pattern.replacement})`,
				);
			}
			lines.push("", "Use /pii test <text> to check sample content.");
			context.showInfo(lines.join("\n"));
			break;
		}

		case "test": {
			const sample = args.slice(1).join(" ").trim();
			if (!sample) {
				context.showError("Usage: /pii test <text>");
				return;
			}
			const detector = new PiiDetector();
			const result = detector.redact(sample);
			const lines = [
				"PII test results:",
				`  Detected: ${result.hasPii ? "yes" : "no"}`,
				`  Patterns: ${
					result.detectedPatterns.length > 0
						? result.detectedPatterns.join(", ")
						: "(none)"
				}`,
				`  Original length: ${result.originalLength}`,
				`  Redacted length: ${result.redactedLength}`,
				"",
				"Redacted output:",
				result.redactedContent,
			];
			context.showInfo(lines.join("\n"));
			break;
		}

		default:
			context.showInfo(PII_USAGE);
	}
}
