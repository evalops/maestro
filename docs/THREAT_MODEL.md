# Threat Model

Audience: security auditors, operators deploying Maestro in sensitive environments.
Nav: [Docs index](README.md) · [Safety](SAFETY.md) · [Enterprise](ENTERPRISE.md)

This document describes Maestro's security architecture, trust boundaries, and mitigations against common attack vectors.

---

## Trust Boundaries

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              EXTERNAL TRUST BOUNDARY                         │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                        LLM Provider APIs                               │  │
│  │    Anthropic  ·  OpenAI  ·  Google  ·  Groq  ·  Custom Providers      │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                     ▲                                        │
│                                     │ HTTPS/TLS                              │
│                                     ▼                                        │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                      MAESTRO PROCESS BOUNDARY                         │  │
│  │                                                                         │  │
│  │  ┌─────────────┐   ┌─────────────┐   ┌─────────────────────────────┐  │  │
│  │  │   Agent     │◄──│   Safety    │◄──│     Tool Execution          │  │  │
│  │  │   Core      │   │   Layer     │   │  bash · read · write · edit │  │  │
│  │  └─────────────┘   └─────────────┘   └─────────────────────────────┘  │  │
│  │         │                │                         │                   │  │
│  │         │                ▼                         ▼                   │  │
│  │         │         ┌─────────────┐         ┌─────────────────┐         │  │
│  │         │         │  Policy     │         │   Filesystem    │         │  │
│  │         │         │  Engine     │         │   (Workspace)   │         │  │
│  │         │         └─────────────┘         └─────────────────┘         │  │
│  │         │                                                              │  │
│  │         ▼                                                              │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │                   User Interface (TUI/Web/CLI)                   │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                     ▲                                        │
│                                     │ Terminal/HTTP                          │
│                                     ▼                                        │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                              USER                                       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Threat Categories

### 1. Prompt Injection

**Risk:** LLM receives malicious instructions embedded in user input, file contents, or web fetches.

**Attack Surface:**
- User messages containing adversarial prompts
- File contents read by the agent (e.g., README.md, source code)
- Web pages fetched via `webfetch` tool
- MCP server responses

**Mitigations:**
| Control | Location | Description |
|---------|----------|-------------|
| Action Firewall | `src/safety/action-firewall.ts` | Blocks dangerous bash patterns regardless of LLM intent |
| Semantic Analysis | `src/safety/action-firewall.ts` | Tree-sitter parses bash commands for semantic inspection |
| User Approval | `src/agent/action-approval.ts` | High-risk operations require explicit user consent |
| System Path Protection | `src/security/directory-access.ts` | Hard blocks writes to `/etc`, `/usr`, `/var`, etc. |
| Safe Mode | `src/safety/safe-mode.ts` | Restricts shell operations when enabled |

**Residual Risk:** Medium. LLM may still produce harmful output that evades pattern matching. User approval is the primary defense for novel attacks.

---

### 2. Arbitrary Code Execution

**Risk:** Agent executes malicious shell commands on the host system.

**Attack Surface:**
- `bash` tool execution
- Background tasks
- MCP server tool calls

**Mitigations:**
| Control | Location | Description |
|---------|----------|-------------|
| Regex + Semantic Firewall | `src/safety/action-firewall.ts` | Detects `rm -rf`, `mkfs`, `dd`, privilege escalation |
| Docker Sandbox | `src/sandbox/` | Optional container isolation for untrusted workspaces |
| Process Resource Limits | `src/tools/background-tasks.ts` | CPU and memory limits for background processes |
| Approval Required | TUI/CLI | User must approve flagged commands |

**Configuration:**
```bash
# Enable Docker sandbox
maestro --sandbox docker

# Reject all high-risk commands automatically
maestro --approval-mode fail
```

**Residual Risk:** Low when approval mode is `prompt` or `fail`. High when using `auto` approval in untrusted environments.

---

### 3. Data Exfiltration

**Risk:** Sensitive data (API keys, credentials, PII) leaked via LLM responses or external requests.

**Attack Surface:**
- LLM context window contains sensitive file contents
- Web search queries may include sensitive terms
- Tool results sent back to LLM provider

**Mitigations:**
| Control | Location | Description |
|---------|----------|-------------|
| PII Detection | `src/safety/semantic-judge.ts` | Scans for common PII patterns before external transmission |
| Secret Redaction | `src/utils/secret-redactor.ts` | Redacts API keys and tokens in logs and outputs |
| Guardian Pre-commit | `.maestro/guardian.json` | Blocks commits containing secrets (Semgrep rules) |
| Telemetry Opt-out | Default off | No data sent to Anthropic telemetry by default |
| Audit Logging | `src/audit/` | HMAC-verified logs of sensitive operations (enterprise) |

**Residual Risk:** Medium. Files read into context may contain secrets. Use workspace isolation for sensitive projects.

---

### 4. Directory Traversal / Filesystem Access

**Risk:** Agent reads or writes files outside the intended workspace.

**Attack Surface:**
- `read`, `write`, `edit` tools with path arguments
- Symlink following
- Parent directory escapes (`../`)

**Mitigations:**
| Control | Location | Description |
|---------|----------|-------------|
| Path Validation | `src/utils/path-validation.ts` | Resolves symlinks, blocks `..` escapes |
| Directory ACLs | `src/security/directory-access.ts` | Allowlist/denylist for path patterns |
| System Path Blocks | Hardcoded | `/etc`, `/usr`, `/var`, `/boot`, `/dev`, `/proc`, `/sys` always blocked |
| Workspace Containment | `src/safety/policy.ts` | Approval required for writes outside project root |

**Example Policy:**
```json
{
  "directoryAccess": {
    "allow": ["./src/**", "./test/**"],
    "deny": ["./secrets/**", "./.env*"]
  }
}
```

**Residual Risk:** Low. Path validation is comprehensive but complex symlink chains may bypass checks.

---

### 5. Network-Based Attacks

**Risk:** Agent makes unauthorized network requests or connects to malicious endpoints.

**Attack Surface:**
- `webfetch` and `websearch` tools
- MCP server connections
- LLM API requests

**Mitigations:**
| Control | Location | Description |
|---------|----------|-------------|
| Rate Limiting | `src/server/rate-limiter.ts` | TieredRateLimiter prevents request floods |
| URL Validation | `src/tools/webfetch.ts` | Blocks private IP ranges, localhost |
| TLS Enforcement | Provider transports | All LLM API calls use HTTPS |
| Network Config | `src/providers/network-config.ts` | Proxy and timeout configuration |

**Residual Risk:** Low. Web fetch is rate-limited and URL-validated.

---

### 6. Denial of Service

**Risk:** Resource exhaustion via runaway processes or excessive LLM calls.

**Attack Surface:**
- Infinite loops in bash commands
- Background tasks consuming resources
- Context window exhaustion

**Mitigations:**
| Control | Location | Description |
|---------|----------|-------------|
| Background Task Limits | `src/tools/background-tasks.ts` | Max concurrent tasks, CPU/memory limits |
| Execution Timeouts | Tool implementations | Configurable timeouts for all tools |
| Context Compaction | `src/cli-tui/session/conversation-compactor.ts` | Auto-compacts at 85% context usage |
| Rate Limiting | `src/server/rate-limiter.ts` | Per-route and global request limits |

**Residual Risk:** Low. Resource limits are configurable and enforced.

---

### 7. Supply Chain / Dependency Risks

**Risk:** Malicious code in dependencies or MCP servers.

**Attack Surface:**
- npm dependencies
- MCP server plugins
- Custom provider implementations

**Mitigations:**
| Control | Location | Description |
|---------|----------|-------------|
| Lockfile Pinning | `package-lock.json`, `bun.lockb` | Exact version pinning |
| Guardian CI | `.github/workflows/` | Semgrep security scanning in CI |
| MCP Isolation | Per-server processes | MCP servers run in separate processes |
| Dependency Audit | `npm audit` | Regular vulnerability scanning |

**Residual Risk:** Medium. MCP servers have broad capabilities. Vet servers before enabling.

---

## Authentication & Authorization

### Local Mode (TUI/CLI)
- **Authentication:** Implicit - runs as the local user
- **Authorization:** Unix filesystem permissions

### Web Server Mode
- **Authentication:** API key header (`X-Maestro-API-Key`) or enterprise SSO
- **Authorization:** RBAC via `src/rbac/permissions.ts` (enterprise)
- **Session Management:** UUID-based sessions with configurable expiry

### Enterprise Features
| Feature | Location | Description |
|---------|----------|-------------|
| JWT Authentication | `src/auth/jwt.ts` | Token-based auth with refresh |
| SSO Integration | `src/auth/sso.ts` | OIDC/SAML support |
| Audit Logging | `src/audit/` | Tamper-evident logs with HMAC |
| Key Rotation | `src/db/encryption.ts` | Encrypted settings with key rotation |

---

## Secure Deployment Checklist

### Local Development
- [ ] Keep approval mode as `prompt` (default)
- [ ] Install Guardian pre-commit hooks: `npm run guardian:install-hook`
- [ ] Review tool calls before approving
- [ ] Use Docker sandbox for untrusted repos: `--sandbox docker`

### CI/CD Pipelines
- [ ] Set `--approval-mode fail` to block dangerous commands
- [ ] Run in ephemeral containers
- [ ] Limit network access to required endpoints
- [ ] Use read-only filesystem mounts where possible

### Web Server Production
- [ ] Enable TLS termination at reverse proxy
- [ ] Configure authentication (API key or SSO)
- [ ] Set restrictive CORS headers
- [ ] Deploy behind rate-limiting proxy
- [ ] Monitor audit logs for anomalies
- [ ] Use Docker sandbox mode
- [ ] Run as non-root user

---

## Incident Response

### Suspected Prompt Injection
1. Review session history: `/sessions` to examine conversation
2. Check audit log: `cat ~/.maestro/audit.log | grep -i suspicious`
3. Report patterns to maintainers for firewall rule updates

### Unauthorized File Access
1. Examine tool results in session for unexpected paths
2. Check directory access policy: `.maestro/policy.json`
3. Tighten allowlist/denylist rules

### Credential Exposure
1. Rotate exposed credentials immediately
2. Review PII detection logs
3. Enable Guardian hooks to prevent future commits

---

## Security Contacts

- **Issues:** https://github.com/evalops/maestro/security
- **Email:** security@evalops.io
- **Responsible Disclosure:** 90-day disclosure window

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2025-12-01 | Initial threat model |
