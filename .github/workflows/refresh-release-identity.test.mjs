import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertReleaseIdentity,
  releaseIdentityConfiguration,
  renewReleaseIdentity,
} from "./refresh-release-identity.mjs";

const env = {
  MAESTRO_RELEASE_TEST_SESSION_SECRET: "projects/evalops-prod/secrets/maestro-release-test-identity-session",
  MAESTRO_RELEASE_TEST_ORG_ID: "release-org",
  MAESTRO_RELEASE_TEST_WORKSPACE_ID: "release-workspace",
  MAESTRO_RELEASE_TEST_SUBJECT: "release-user",
};
const config = releaseIdentityConfiguration(env);
const claims = {
  active: true,
  token_type: "access",
  sub: "release-user",
  organization_id: "release-org",
  workspace_id: "release-workspace",
  scopes: ["llm_gateway:invoke"],
  aud: ["https://llm-gateway.evalops.dev"],
  exp: Math.floor(Date.now() / 1000) + 300,
};

test("native refresh rotates and saves before access validation", async () => {
  const calls = [];
  let saved;
  const renewed = await renewReleaseIdentity(
    { type: "oauth", access: "old-access", refresh: "old-refresh", expires: Date.now() },
    config,
    async (tokens) => { saved = tokens; },
    async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/v1/tokens/refresh")) {
        assert.deepEqual(JSON.parse(options.body), { refresh_token: "old-refresh" });
        return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 300 });
      }
      assert.equal(options.headers.authorization, "Bearer new-access");
      return Response.json(claims);
    },
  );
  assert.equal(renewed.access, "new-access");
  assert.equal(saved.refresh, "new-refresh");
  assert.equal(calls.length, 2);
});

test("identity admission rejects service tokens and tenant drift", () => {
  for (const change of [{ token_type: "service" }, { organization_id: "other-org" }, { sub: "other-user" }, { scopes: [] }]) {
    assert.throws(() => assertReleaseIdentity({ ...claims, ...change }, config), /does not match/);
  }
});

test("configuration requires a distinct managed session and exact tenant binding", () => {
  assert.throws(
    () => releaseIdentityConfiguration({ ...env, MAESTRO_RELEASE_TEST_SESSION_SECRET: "not-a-resource" }),
    /Secret Manager resource/,
  );
  assert.throws(() => releaseIdentityConfiguration({ ...env, MAESTRO_RELEASE_TEST_SUBJECT: "" }), /MAESTRO_RELEASE_TEST_SUBJECT/);
});
