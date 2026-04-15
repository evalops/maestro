/**
 * macOS Notarization Script
 *
 * This script is called by electron-builder after signing the app.
 * It notarizes the app with Apple's notary service.
 *
 * Required environment variables:
 *   - APPLE_ID: Your Apple ID email
 *   - APPLE_APP_SPECIFIC_PASSWORD: App-specific password from appleid.apple.com
 *   - APPLE_TEAM_ID: Your Apple Developer Team ID
 *
 * For CI/CD, you can also use:
 *   - APPLE_API_KEY: App Store Connect API Key ID
 *   - APPLE_API_KEY_PATH: Path to the .p8 key file
 *   - APPLE_API_ISSUER: App Store Connect Issuer ID
 */

const { notarize } = require("@electron/notarize");
const path = require("node:path");

async function notarizeApp(context) {
	// Only notarize on macOS
	if (process.platform !== "darwin") {
		console.log("Skipping notarization: not on macOS");
		return;
	}

	// Skip if explicitly disabled
	if (process.env.SKIP_NOTARIZE === "true") {
		console.log("Skipping notarization: SKIP_NOTARIZE=true");
		return;
	}

	// Check for required credentials
	const appleId = process.env.APPLE_ID;
	const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
	const teamId = process.env.APPLE_TEAM_ID;

	// Alternative: App Store Connect API Key authentication
	const apiKey = process.env.APPLE_API_KEY;
	const apiKeyPath = process.env.APPLE_API_KEY_PATH;
	const apiIssuer = process.env.APPLE_API_ISSUER;

	const hasCredentials = appleId && appleIdPassword && teamId;
	const hasApiKey = apiKey && apiKeyPath && apiIssuer;

	if (!hasCredentials && !hasApiKey) {
		console.log("Skipping notarization: missing credentials");
		console.log("Set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID");
		console.log(
			"Or set APPLE_API_KEY, APPLE_API_KEY_PATH, and APPLE_API_ISSUER",
		);
		return;
	}

	const appName = context.packager.appInfo.productFilename;
	const appPath = path.join(context.appOutDir, `${appName}.app`);

	console.log(`Notarizing ${appName}...`);
	console.log(`App path: ${appPath}`);

	try {
		const notarizeOptions = {
			appPath,
			tool: "notarytool",
		};

		if (hasApiKey) {
			// Use App Store Connect API Key (recommended for CI/CD)
			notarizeOptions.appleApiKey = apiKeyPath;
			notarizeOptions.appleApiKeyId = apiKey;
			notarizeOptions.appleApiIssuer = apiIssuer;
		} else {
			// Use Apple ID credentials
			notarizeOptions.appleId = appleId;
			notarizeOptions.appleIdPassword = appleIdPassword;
			notarizeOptions.teamId = teamId;
		}

		await notarize(notarizeOptions);

		console.log(`Successfully notarized ${appName}`);
	} catch (error) {
		console.error("Notarization failed:", error);
		// Don't fail the build if notarization fails in development
		if (process.env.CI) {
			throw error;
		}
	}
}

module.exports = notarizeApp;
