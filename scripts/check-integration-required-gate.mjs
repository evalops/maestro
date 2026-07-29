import { pathToFileURL } from "node:url";

export function evaluateIntegrationRequiredGate({
  pathCheckResult,
  integrationPathsChanged,
  integrationSuiteResult,
}) {
  if (pathCheckResult !== "success") {
    return {
      ok: false,
      message: `integration path detection did not succeed: ${pathCheckResult || "missing"}`,
    };
  }

  if (integrationPathsChanged === "true") {
    return integrationSuiteResult === "success"
      ? { ok: true, message: "integration suite succeeded for relevant paths" }
      : {
          ok: false,
          message: `integration suite did not succeed for relevant paths: ${integrationSuiteResult || "missing"}`,
        };
  }

  if (integrationPathsChanged === "false") {
    return integrationSuiteResult === "skipped"
      ? { ok: true, message: "integration suite correctly skipped for irrelevant paths" }
      : {
          ok: false,
          message: `integration suite was not skipped for irrelevant paths: ${integrationSuiteResult || "missing"}`,
        };
  }

  return {
    ok: false,
    message: `integration path detection produced an invalid result: ${integrationPathsChanged || "missing"}`,
  };
}

function main() {
  const result = evaluateIntegrationRequiredGate({
    pathCheckResult: process.env.PATH_CHECK_RESULT,
    integrationPathsChanged: process.env.INTEGRATION_PATHS_CHANGED,
    integrationSuiteResult: process.env.INTEGRATION_SUITE_RESULT,
  });

  console.log(result.message);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
