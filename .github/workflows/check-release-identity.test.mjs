import assert from "node:assert/strict";
import { test } from "node:test";
import { checkReleaseIdentity } from "./check-release-identity.mjs";

const env = { MAESTRO_EVALOPS_ACCESS_TOKEN: "test-bearer", MAESTRO_EVALOPS_ORG_ID: "release-org" };
const identity = { active: true, token_type: "access", subject: "release-user", organization_id: "release-org", workspace_id: "release-workspace", scopes: ["llm_gateway:invoke"] };

test("preflight verifies the dedicated session without leaking its bearer", async () => {
  await checkReleaseIdentity(env, async (url, options) => {
    assert.equal(url, "https://identity.evalops.dev/v1/tokens/introspect");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, "Bearer test-bearer");
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json(identity);
  });
});

test("missing credentials fail before any network request", async () => {
  await assert.rejects(checkReleaseIdentity({}, () => assert.fail("unexpected request")), /npm-release environment/);
});

for (const change of [{active:false}, {token_type:"service"}, {subject:""}, {organization_id:"other-org"}, {workspace_id:""}, {scopes:[]}]) {
  test(`preflight rejects invalid admission ${JSON.stringify(change)}`, async () => {
    await assert.rejects(checkReleaseIdentity(env, async () => Response.json({...identity, ...change})), /must be active/);
  });
}

test("transport and server errors never print response bodies or bearer values", async () => {
  for (const request of [async () => {throw new Error("test-bearer");}, async () => new Response("test-bearer", {status:401}), async () => new Response("test-bearer")]) {
    await assert.rejects(checkReleaseIdentity(env, request), error => !error.message.includes("test-bearer"));
  }
});
