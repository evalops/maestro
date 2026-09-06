import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	buildMacosReleaseSignatureMarker,
	parseCodesignDetails,
	validateDeveloperIdSignature,
} from "./check-macos-release-signature.mjs";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const workflow = await readFile(new URL(".github/workflows/release.yml", root), "utf8");
const ciScript = await readFile(new URL("scripts/ci-linux-check.sh", root), "utf8");
const coverageScript = await readFile(new URL("scripts/verify-release-smoke-coverage.mjs", root), "utf8");

const validCodesignOutput = `
Executable=/tmp/maestro
Identifier=maestro
Format= Mach-O 64-bit executable arm64
CodeDirectory v=20500 size=123 flags=0x0(none) hashes=1+5 location=embedded
TeamIdentifier=TEAMID1234
Authority=Developer ID Application: EvalOps (TEAMID1234)
Authority=Developer ID Certification Authority
Signature=not bound
CDHash=fixturehash
`;

test("parses and accepts a non-ad-hoc Developer ID signature with TeamIdentifier", () => {
	const details = parseCodesignDetails(validCodesignOutput);
	assert.deepEqual(details.authorities, [
		"Developer ID Application: EvalOps (TEAMID1234)",
		"Developer ID Certification Authority",
	]);
	assert.deepEqual(
		validateDeveloperIdSignature(details, {
			expectedTeamIdentifier: "TEAMID1234",
			expectedAuthority: "Developer ID Application: EvalOps (TEAMID1234)",
		}),
		{
			authority: "Developer ID Application: EvalOps (TEAMID1234)",
			teamIdentifier: "TEAMID1234",
			identifier: "maestro",
			codeDirectoryHash: "fixturehash",
		},
	);
});

test("rejects ad-hoc signatures and unstable or mismatched team identities", () => {
	const adHoc = parseCodesignDetails(validCodesignOutput.replace("Signature=not bound", "Signature=adhoc"));
	assert.throws(() => validateDeveloperIdSignature(adHoc), /ad.hoc/i);
	const missingTeam = parseCodesignDetails(validCodesignOutput.replace("TeamIdentifier=TEAMID1234", "TeamIdentifier=not set"));
	assert.throws(() => validateDeveloperIdSignature(missingTeam), /TeamIdentifier/i);
	const mismatch = parseCodesignDetails(validCodesignOutput);
	assert.throws(
		() => validateDeveloperIdSignature(mismatch, { expectedTeamIdentifier: "OTHERTEAM1" }),
		/does not match/i,
	);
});

test("signature markers bind the accepted identity to the exact binary digest", () => {
	const directory = mkdtempSync(join(tmpdir(), "maestro-signature-marker-"));
	const binary = join(directory, "maestro-darwin-arm64");
	const contents = Buffer.from("signed binary fixture\n");
	writeFileSync(binary, contents);
	const marker = buildMacosReleaseSignatureMarker(
		binary,
		parseCodesignDetails(validCodesignOutput),
		{ expectedTeamIdentifier: "TEAMID1234" },
	);
	assert.equal(marker.binary, "maestro-darwin-arm64");
	assert.equal(
		marker.binarySha256,
		createHash("sha256").update(contents).digest("hex"),
	);
});

test("release CI preserves the macOS artifact trust boundary", () => {
	assert.match(packageJson.scripts["check:macos-signature"], /macos-release-signature/);
	assert.match(ciScript, /npm run check:macos-signature/);
	assert.match(workflow, /darwin-x64/);
	assert.match(workflow, /darwin-arm64/);
	assert.doesNotMatch(workflow, /security find-identity|notarytool|Developer ID/);
	assert.match(coverageScript, /signed-\$\{platform\}\.json/);
	assert.match(coverageScript, /notarized-\$\{platform\}\.json/);
	assert.match(coverageScript, /status !== "Accepted"/);
	assert.match(coverageScript, /binarySha256 !== actual/);
	assert.match(coverageScript, /stable Developer ID authority and TeamIdentifier/);
});

test("rejects a missing or changed identifier that would invalidate saved Keychain grants", () => {
    for (const identifier of ["", "maestro-darwin-arm64", "maestro-new", "dev.evalops.maestro"]) {
        const details = parseCodesignDetails(validCodesignOutput.replace("Identifier=maestro", `Identifier=${identifier}`));
        assert.throws(() => validateDeveloperIdSignature(details), /identifier/i);
    }
});
