import {
	buildCustomerValueReport,
	formatCustomerValueMarkdown,
	formatCustomerValueReport,
	writeCustomerValueArtifacts,
} from "../../customer-value/report.js";

interface ValueOptions {
	format?: string;
	outputDir?: string;
	sessionDir?: string;
	telemetryPath?: string;
	writeArtifacts?: boolean;
}

export async function handleValueCommand(
	period?: string,
	options: ValueOptions = {},
): Promise<void> {
	const report = await buildCustomerValueReport({
		period,
		sessionDir: options.sessionDir,
		telemetryPath: options.telemetryPath,
	});
	const artifacts = options.writeArtifacts
		? await writeCustomerValueArtifacts(report, {
				outputDir: options.outputDir,
			})
		: undefined;

	if (options.format === "json") {
		console.log(
			JSON.stringify(artifacts ? { report, artifacts } : report, null, 2),
		);
		return;
	}
	if (options.format === "md" || options.format === "markdown") {
		console.log(formatCustomerValueMarkdown(report));
		if (artifacts) {
			console.log(`\nSaved value artifact manifest: ${artifacts.manifestPath}`);
		}
		return;
	}
	console.log(formatCustomerValueReport(report));
	if (artifacts) {
		console.log("");
		console.log(`Saved value artifacts: ${artifacts.outputDir}`);
		console.log(`Manifest: ${artifacts.manifestPath}`);
		console.log(`Report JSON: ${artifacts.reportJsonPath}`);
		console.log(`Report Markdown: ${artifacts.reportMarkdownPath}`);
	}
}
