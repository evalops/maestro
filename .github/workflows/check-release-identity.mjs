import { pathToFileURL } from "node:url";

// Use the same admission fields as the released native agent. This is a
// prerequisite check, never a replacement for the installed replay canary.
export async function checkReleaseIdentity(env, request = fetch) {
  const token = env.MAESTRO_EVALOPS_ACCESS_TOKEN?.trim();
  const organization = env.MAESTRO_EVALOPS_ORG_ID?.trim();
  if (!token || !organization) {
    throw new Error("Configure MAESTRO_RELEASE_TEST_ACCESS_TOKEN and MAESTRO_RELEASE_TEST_ORG_ID in the npm-release environment for a dedicated release-test account.");
  }
  let response;
  try {
    response = await request("https://identity.evalops.dev/v1/tokens/introspect", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error("Release-test Identity verification could not connect; publication has not started.");
  }
  if (!response.ok) throw new Error("Release-test Identity session was rejected; renew its credential before publishing.");
  let identity;
  try { identity = await response.json(); } catch {
    throw new Error("Release-test Identity returned an invalid response.");
  }
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) throw new Error("Release-test Identity returned an invalid response.");
  const scopes = [...(Array.isArray(identity.scopes) ? identity.scopes : []), ...(typeof identity.scope === "string" ? identity.scope.split(/\s+/) : [])];
  if (identity.active !== true || identity.token_type !== "access" ||
      typeof identity.subject !== "string" || !identity.subject.trim() ||
      identity.organization_id !== organization ||
      typeof identity.workspace_id !== "string" || !identity.workspace_id.trim() ||
      !scopes.includes("llm_gateway:invoke")) {
    throw new Error("Release-test Identity must be active, bound to the configured organization and a test workspace, and scoped to llm_gateway:invoke.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await checkReleaseIdentity(process.env);
    console.log("Release-test Identity verified; no model request was sent.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
