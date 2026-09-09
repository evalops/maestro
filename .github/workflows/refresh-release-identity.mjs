import { appendFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const issuer = "https://identity.evalops.dev";
const resource = "https://llm-gateway.evalops.dev";

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} in the protected npm-release environment.`);
  return value;
}

export function releaseIdentityConfiguration(env = process.env) {
  const secret = required(env, "MAESTRO_RELEASE_TEST_SESSION_SECRET");
  if (!/^projects\/[^/]+\/secrets\/[A-Za-z0-9_-]+$/.test(secret)) {
    throw new Error("MAESTRO_RELEASE_TEST_SESSION_SECRET must be a Secret Manager resource.");
  }
  return {
    secret,
    organizationId: required(env, "MAESTRO_RELEASE_TEST_ORG_ID"),
    workspaceId: required(env, "MAESTRO_RELEASE_TEST_WORKSPACE_ID"),
    subject: required(env, "MAESTRO_RELEASE_TEST_SUBJECT"),
  };
}

function audiences(claims) {
  return Array.isArray(claims?.aud) ? claims.aud : [claims?.aud];
}

function scopes(claims) {
  return [
    ...(Array.isArray(claims?.scopes) ? claims.scopes : []),
    ...(typeof claims?.scope === "string" ? claims.scope.split(/\s+/) : []),
  ];
}

export function assertReleaseIdentity(claims, config) {
  if (
    claims?.active !== true ||
    claims.token_type !== "access" ||
    claims.sub !== config.subject ||
    claims.organization_id !== config.organizationId ||
    claims.workspace_id !== config.workspaceId ||
    !scopes(claims).includes("llm_gateway:invoke") ||
    !audiences(claims).includes(resource) ||
    !Number.isFinite(claims.exp) ||
    claims.exp * 1000 <= Date.now()
  ) {
    throw new Error("Release-test Identity session does not match the dedicated Maestro canary.");
  }
}

async function introspect(access, fetcher) {
  const response = await fetcher(`${issuer}/v1/tokens/introspect`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${access}` },
  });
  if (!response.ok) throw new Error(`Release-test Identity validation failed (${response.status}).`);
  try {
    return await response.json();
  } catch {
    throw new Error("Release-test Identity returned malformed JSON.");
  }
}

function normalizedSession(value) {
  if (
    !value ||
    typeof value.refresh !== "string" ||
    !value.refresh ||
    typeof value.access !== "string" ||
    !value.access ||
    !Number.isFinite(value.expires)
  ) {
    throw new Error("Stored Maestro release-test session is malformed; enroll the dedicated account.");
  }
  return value;
}

export async function renewReleaseIdentity(tokens, config, save, fetcher = fetch) {
  const current = normalizedSession(tokens);
  const response = await fetcher(`${issuer}/v1/tokens/refresh`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: current.refresh }),
  });
  if (!response.ok) {
    throw new Error(`Release-test Identity renewal failed (${response.status}); re-enroll if revoked.`);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("Release-test Identity renewal returned malformed JSON.");
  }
  if (
    typeof body.access_token !== "string" ||
    !body.access_token ||
    typeof body.refresh_token !== "string" ||
    !body.refresh_token ||
    !Number.isFinite(body.expires_in) ||
    body.expires_in <= 0
  ) {
    throw new Error("Release-test Identity renewal returned an invalid session.");
  }
  const renewed = {
    type: "oauth",
    access: body.access_token,
    refresh: body.refresh_token,
    expires: Date.now() + body.expires_in * 1000,
    metadata: {
      identityBaseUrl: issuer,
      organizationId: body.organization_id ?? config.organizationId,
      workspaceId: body.workspace_id ?? config.workspaceId,
      scopes: scopes(body),
    },
  };
  // Rotation is one-use: persist the new refresh token before introspection
  // or a later network failure can consume it without a recoverable copy.
  await save(renewed);
  assertReleaseIdentity(await introspect(renewed.access, fetcher), config);
  return renewed;
}

export async function secretManagerStore(config) {
  let stdout;
  try {
    ({ stdout } = await exec("gcloud", ["auth", "print-access-token"], { maxBuffer: 65536 }));
  } catch {
    throw new Error("GitHub OIDC could not obtain a Secret Manager access token.");
  }
  const authorization = `Bearer ${stdout.trim()}`;
  const url = `https://secretmanager.googleapis.com/v1/${config.secret}`;
  async function request(suffix, init = {}) {
    const response = await fetch(url + suffix, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        authorization,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) throw new Error(`Release-test Secret Manager operation failed (${response.status}).`);
    try {
      return await response.json();
    } catch {
      throw new Error("Release-test Secret Manager returned malformed JSON.");
    }
  }
  return {
    async read() {
      const body = await request("/versions/latest:access");
      try {
        return JSON.parse(Buffer.from(body.payload.data, "base64").toString("utf8"));
      } catch {
        throw new Error("Stored Maestro release-test session is malformed; enroll the dedicated account.");
      }
    },
    async save(tokens) {
      await request(":addVersion", {
        method: "POST",
        body: JSON.stringify({
          payload: { data: Buffer.from(JSON.stringify(tokens)).toString("base64") },
        }),
      });
    },
  };
}

export async function refreshReleaseIdentity(env = process.env) {
  const config = releaseIdentityConfiguration(env);
  const store = await secretManagerStore(config);
  const tokens = await renewReleaseIdentity(await store.read(), config, (next) => store.save(next));
  if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `MAESTRO_EVALOPS_ACCESS_TOKEN=${tokens.access}\n`);
  return { config, expires: tokens.expires };
}

if (process.argv[1]?.endsWith("refresh-release-identity.mjs")) {
  try {
    await refreshReleaseIdentity();
    console.log("Release-test Identity session refreshed and admitted.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Release-test Identity refresh failed.");
    process.exitCode = 1;
  }
}
