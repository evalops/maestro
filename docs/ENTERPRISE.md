# Maestro Enterprise

Updated: 2026-08-17

Audience: operators deploying Maestro against EvalOps Platform, or locally with
bring-your-own-key (BYOK) provider credentials.

Nav: [Docs index](README.md) · [Safety](SAFETY.md) · [Threat model](THREAT_MODEL.md)

## Product rule

Maestro has two credential modes. A process must be in one of them before a
model turn starts.

| Mode | How it is selected | Inference | Secrets |
| --- | --- | --- | --- |
| Platform | `maestro evalops login` or `MAESTRO_EVALOPS_ACCESS_TOKEN` + `MAESTRO_EVALOPS_ORG_ID` | `llm-gateway` with a `provider_ref` | Org keys live in Platform `keys`. Maestro does not unwrap them. |
| BYOK | No identity session, plus one usable local connection | Direct vendor APIs | Local keyring, env, file, 1Password, or delegated provider login. |

There is no Maestro-owned password, user table, or RBAC implementation. Human
login, org membership, and permission checks belong to Platform `identity`.
Managed provider credentials belong to Platform `keys`. Managed inference
belongs to `llm-gateway`.

Platform mode ignores local provider keys. It does not fall back to
`ANTHROPIC_API_KEY` or `OPENAI_API_KEY` when `llm-gateway` or `identity` is
unavailable. Sign out and complete BYOK if you need a local path.

## First-run

```sh
maestro setup
```

The command offers two choices:

1. Sign in to EvalOps (`maestro evalops login` or `maestro setup --platform`)
2. Use your own API key (`maestro connections add` or `maestro setup --byok`)

`maestro doctor` reports `credential_mode`. The process is not ready until that
check passes.

## Platform mode

`identity` at `https://identity.evalops.dev` is the only issuer.

- CLI login is the existing PKCE loopback flow in `packages/tui-rs/src/init_cli.rs`.
- The stored session carries access token, refresh token, `organization_id`,
  and the selected `provider_ref`.
- Model calls use the `evalops` provider in `packages/ai-rs` and go to
  `https://llm-gateway.evalops.dev/v1`.
- `maestro connections` lists and selects org provider refs. `add` uploads a
  key to `POST /v1/provider-refs` and does not keep the secret locally.
- The runtime gateway verifies identity JWTs against JWKS or
  `MAESTRO_JWT_SECRET`. `AuthContext` carries `subject`, `organization_id`,
  `workspace_id`, `scopes`, and `source`.

Canonical env vars:

```sh
MAESTRO_EVALOPS_ACCESS_TOKEN=
MAESTRO_EVALOPS_ORG_ID=
MAESTRO_EVALOPS_WORKSPACE_ID=
MAESTRO_KEYS_URL=https://keys.evalops.dev
MAESTRO_EVALOPS_BASE_URL=https://llm-gateway.evalops.dev/v1
```

Legacy aliases such as `EVALOPS_TOKEN` and `MAESTRO_ENTERPRISE_ORG_ID` are not
read.

## BYOK mode

No identity session. No `llm-gateway`. A usable local connection is required.

```sh
maestro connections add anthropic-api-key work --secret-stdin
maestro connections add openai-api-key work --from-1password op://vault/item/key
maestro codex login
```

The runtime gateway stays loopback-open, or uses `MAESTRO_WEB_API_KEY` for a
non-loopback bind. That key authenticates the browser to this process. It is
not a provider key.

## Runtime-gateway authentication

See [Threat model](THREAT_MODEL.md). Supported authenticators:

- `MAESTRO_WEB_API_KEY` (static process key, unrestricted)
- identity JWT (`MAESTRO_JWT_SECRET` or `MAESTRO_JWT_JWKS_URL`)
- trusted-proxy adapter (`MAESTRO_WEB_TRUST_PROXY_AUTH_TOKEN` plus identity headers)
- HMAC session cookie derived from a prior successful auth
- loopback development with no auth configured

`MAESTRO_AUTH_SHARED_SECRET` is removed.

## What this file used to claim

Earlier revisions described a Maestro-local password, bcrypt, Drizzle, and
RBAC schema. That stack is not implemented and must not be added. Use
Platform `identity` for org roles and `keys` for provider credentials.
