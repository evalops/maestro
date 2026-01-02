# OAuth & Authentication Design

The authentication system supports multiple providers and methods, including API keys, OAuth flows, and enterprise SSO integration.

## Overview

Authentication capabilities:

- **Multi-Provider OAuth**: Anthropic, OpenAI, GitHub Copilot, Google Gemini CLI
- **API Key Management**: Secure storage and rotation
- **Token Refresh**: Automatic credential renewal
- **Credential Encryption**: At-rest encryption for secrets
- **2FA Support**: TOTP-based two-factor authentication

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Authentication Architecture                      │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    Auth Service                              │    │
│  │  - Credential validation                                    │    │
│  │  - Provider selection                                       │    │
│  │  - Token management                                         │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                              │                                       │
│           ┌──────────────────┼──────────────────┐                   │
│           ▼                  ▼                  ▼                   │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐        │
│  │ API Key Auth   │  │ OAuth Flow     │  │ Enterprise SSO │        │
│  │ - Env vars     │  │ - PKCE         │  │ - SAML         │        │
│  │ - Config file  │  │ - Callback     │  │ - OIDC         │        │
│  │ - Secure store │  │ - Token store  │  │ - JWT verify   │        │
│  └────────────────┘  └────────────────┘  └────────────────┘        │
│                              │                                       │
│                              ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                  Credential Storage                          │    │
│  │  - Encrypted at rest (AES-256-GCM)                          │    │
│  │  - Platform keychain integration                            │    │
│  │  - Automatic rotation support                               │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

## Provider Support

### Anthropic OAuth

```typescript
// src/oauth/anthropic.ts
class AnthropicOAuthProvider {
  private clientId: string;
  private redirectUri: string;

  async initiateFlow(): Promise<{ authUrl: string; state: string }> {
    const state = generateSecureRandom(32);
    const codeVerifier = generateSecureRandom(64);
    const codeChallenge = await sha256Base64Url(codeVerifier);

    // Store PKCE verifier for callback
    await this.storeVerifier(state, codeVerifier);

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: "user:read messages:write",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256"
    });

    return {
      authUrl: `https://console.anthropic.com/oauth/authorize?${params}`,
      state
    };
  }

  async handleCallback(
    code: string,
    state: string
  ): Promise<AuthTokens> {
    const codeVerifier = await this.getVerifier(state);

    const response = await fetch(
      "https://console.anthropic.com/oauth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: this.clientId,
          code,
          redirect_uri: this.redirectUri,
          code_verifier: codeVerifier
        })
      }
    );

    const tokens = await response.json();

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000
    };
  }
}
```

### OpenAI OAuth

```typescript
// src/oauth/openai.ts
class OpenAIOAuthProvider {
  async initiateFlow(): Promise<{ authUrl: string; state: string }> {
    const state = generateSecureRandom(32);
    const codeVerifier = generateSecureRandom(64);
    const codeChallenge = await sha256Base64Url(codeVerifier);

    await this.storeVerifier(state, codeVerifier);

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: "openid profile email",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256"
    });

    return {
      authUrl: `https://auth.openai.com/authorize?${params}`,
      state
    };
  }

  async refreshTokens(refreshToken: string): Promise<AuthTokens> {
    const response = await fetch("https://auth.openai.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: this.clientId,
        refresh_token: refreshToken
      })
    });

    return await response.json();
  }
}
```

### GitHub Copilot

```typescript
// src/oauth/github-copilot.ts
class GitHubCopilotOAuthProvider {
  async initiateDeviceFlow(): Promise<DeviceFlowResponse> {
    const response = await fetch(
      "https://github.com/login/device/code",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          client_id: this.clientId,
          scope: "copilot"
        })
      }
    );

    const data = await response.json();

    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      expiresIn: data.expires_in,
      interval: data.interval
    };
  }

  async pollForToken(deviceCode: string): Promise<AuthTokens | null> {
    const response = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          client_id: this.clientId,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code"
        })
      }
    );

    const data = await response.json();

    if (data.error === "authorization_pending") {
      return null;  // Keep polling
    }

    if (data.error) {
      throw new Error(data.error_description);
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000
    };
  }
}
```

## Local OAuth Server

For CLI OAuth flows, a local server handles callbacks:

```typescript
// src/oauth/local-server.ts
class LocalOAuthServer {
  private server: Server | null = null;
  private port: number;

  async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        const url = new URL(req.url!, `http://localhost:${this.port}`);

        if (url.pathname === "/callback") {
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          const error = url.searchParams.get("error");

          if (error) {
            this.handleError(res, error);
          } else {
            this.handleSuccess(res, code!, state!);
          }
        }
      });

      this.server.listen(this.port, () => {
        resolve(`http://localhost:${this.port}/callback`);
      });

      this.server.on("error", reject);
    });
  }

  private handleSuccess(res: ServerResponse, code: string, state: string) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`
      <html>
        <body>
          <h1>Authentication Successful!</h1>
          <p>You can close this window and return to the CLI.</p>
          <script>window.close();</script>
        </body>
      </html>
    `);

    this.emit("callback", { code, state });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }
}
```

## Credential Storage

### Encryption

```typescript
// src/db/settings-encryption.ts
class CredentialEncryption {
  private key: Buffer;

  constructor(masterKey: string) {
    this.key = deriveKey(masterKey);
  }

  encrypt(plaintext: string): EncryptedValue {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);

    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final()
    ]);

    const authTag = cipher.getAuthTag();

    return {
      ciphertext: encrypted.toString("base64"),
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
      version: 1
    };
  }

  decrypt(encrypted: EncryptedValue): string {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(encrypted.iv, "base64")
    );

    decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));

    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
      decipher.final()
    ]).toString("utf8");
  }
}
```

### Platform Keychain Integration

```typescript
// src/auth/keychain.ts
class KeychainStorage {
  async store(service: string, account: string, value: string): Promise<void> {
    if (process.platform === "darwin") {
      await this.macosStore(service, account, value);
    } else if (process.platform === "linux") {
      await this.linuxStore(service, account, value);
    } else if (process.platform === "win32") {
      await this.windowsStore(service, account, value);
    }
  }

  private async macosStore(
    service: string,
    account: string,
    value: string
  ): Promise<void> {
    await exec([
      "security",
      "add-generic-password",
      "-s", service,
      "-a", account,
      "-w", value,
      "-U"  // Update if exists
    ].join(" "));
  }

  private async linuxStore(
    service: string,
    account: string,
    value: string
  ): Promise<void> {
    // Use secret-tool (GNOME Keyring)
    await exec([
      "secret-tool",
      "store",
      "--label", `${service}:${account}`,
      "service", service,
      "account", account
    ].join(" "), { input: value });
  }
}
```

## Token Management

### Token Refresh

```typescript
// src/auth/token-manager.ts
class TokenManager {
  private tokens: Map<string, AuthTokens> = new Map();
  private refreshPromises: Map<string, Promise<AuthTokens>> = new Map();

  async getToken(provider: string): Promise<string> {
    const tokens = this.tokens.get(provider);

    if (!tokens) {
      throw new Error(`No tokens for provider: ${provider}`);
    }

    // Check if token is about to expire (5 min buffer)
    if (tokens.expiresAt - Date.now() < 5 * 60 * 1000) {
      return await this.refreshToken(provider);
    }

    return tokens.accessToken;
  }

  private async refreshToken(provider: string): Promise<string> {
    // Deduplicate concurrent refresh requests
    let refreshPromise = this.refreshPromises.get(provider);

    if (!refreshPromise) {
      refreshPromise = this.doRefresh(provider);
      this.refreshPromises.set(provider, refreshPromise);
    }

    try {
      const tokens = await refreshPromise;
      return tokens.accessToken;
    } finally {
      this.refreshPromises.delete(provider);
    }
  }

  private async doRefresh(provider: string): Promise<AuthTokens> {
    const tokens = this.tokens.get(provider)!;
    const oauthProvider = this.getProvider(provider);

    const newTokens = await oauthProvider.refreshTokens(tokens.refreshToken);

    // Store new tokens
    this.tokens.set(provider, newTokens);
    await this.persistTokens(provider, newTokens);

    return newTokens;
  }
}
```

## Two-Factor Authentication

### TOTP Implementation

```typescript
// src/auth/totp.ts
class TOTPVerifier {
  private readonly WINDOW_SIZE = 1;  // Allow ±1 time step

  generateSecret(): string {
    const buffer = randomBytes(20);
    return base32Encode(buffer);
  }

  generateURI(secret: string, accountName: string, issuer: string): string {
    const params = new URLSearchParams({
      secret,
      issuer,
      algorithm: "SHA1",
      digits: "6",
      period: "30"
    });

    return `otpauth://totp/${issuer}:${accountName}?${params}`;
  }

  verify(token: string, secret: string): boolean {
    const now = Math.floor(Date.now() / 1000);

    for (let i = -this.WINDOW_SIZE; i <= this.WINDOW_SIZE; i++) {
      const timeStep = Math.floor(now / 30) + i;
      const expectedToken = this.generateToken(secret, timeStep);

      if (timingSafeEqual(token, expectedToken)) {
        return true;
      }
    }

    return false;
  }

  private generateToken(secret: string, timeStep: number): string {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64BE(BigInt(timeStep));

    const key = Buffer.from(base32Decode(secret));
    const hmac = createHmac("sha1", key).update(buffer).digest();

    const offset = hmac[hmac.length - 1] & 0x0f;
    const binary =
      ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff);

    const otp = binary % 1000000;
    return otp.toString().padStart(6, "0");
  }
}
```

### Rate Limiting

```typescript
// src/db/schema.ts - totpRateLimits table
class TOTPRateLimiter {
  private readonly MAX_ATTEMPTS = 5;
  private readonly WINDOW_MS = 15 * 60 * 1000;  // 15 minutes
  private readonly LOCKOUT_MS = 30 * 60 * 1000;  // 30 minutes

  async checkAndIncrement(userId: string): Promise<{
    allowed: boolean;
    remainingAttempts?: number;
    lockedUntil?: Date;
  }> {
    const record = await this.getRecord(userId);
    const now = new Date();

    // Check if locked out
    if (record?.lockedUntil && record.lockedUntil > now) {
      return { allowed: false, lockedUntil: record.lockedUntil };
    }

    // Check if window expired
    if (record && now.getTime() - record.windowStart.getTime() > this.WINDOW_MS) {
      // Reset window
      await this.resetWindow(userId);
      return { allowed: true, remainingAttempts: this.MAX_ATTEMPTS - 1 };
    }

    // Increment attempts
    const newAttempts = (record?.attempts ?? 0) + 1;

    if (newAttempts >= this.MAX_ATTEMPTS) {
      // Lock out
      const lockedUntil = new Date(now.getTime() + this.LOCKOUT_MS);
      await this.lockout(userId, lockedUntil);
      return { allowed: false, lockedUntil };
    }

    await this.incrementAttempts(userId, newAttempts);
    return {
      allowed: true,
      remainingAttempts: this.MAX_ATTEMPTS - newAttempts
    };
  }

  async resetOnSuccess(userId: string): Promise<void> {
    await this.resetWindow(userId);
  }
}
```

## Token Revocation

```typescript
// src/db/schema.ts - revokedTokens table
class TokenRevocationService {
  async revokeToken(
    tokenHash: string,
    userId: string,
    reason: string
  ): Promise<void> {
    await db.insert(revokedTokens).values({
      tokenHash: await hashToken(tokenHash),
      tokenType: "access",
      userId,
      reason,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),  // 7 days
      revokedAt: new Date()
    });
  }

  async isRevoked(tokenHash: string): Promise<boolean> {
    const hash = await hashToken(tokenHash);
    const record = await db
      .select()
      .from(revokedTokens)
      .where(eq(revokedTokens.tokenHash, hash))
      .limit(1);

    return record.length > 0;
  }

  async revokeAllUserTokens(userId: string, reason: string): Promise<void> {
    await db
      .insert(userRevocationTimestamps)
      .values({
        userId,
        revokedBefore: new Date(),
        reason
      })
      .onConflictDoUpdate({
        target: userRevocationTimestamps.userId,
        set: {
          revokedBefore: new Date(),
          reason,
          updatedAt: new Date()
        }
      });
  }
}
```

## API Key Management

```typescript
// src/db/schema.ts - apiKeys table
class APIKeyManager {
  async createKey(
    userId: string,
    orgId: string,
    name: string,
    scopes: string[]
  ): Promise<{ key: string; id: string }> {
    // Generate key
    const keyBytes = randomBytes(32);
    const key = `csk_${keyBytes.toString("hex")}`;
    const keyHash = await bcrypt.hash(key, 12);
    const keyPrefix = key.substring(0, 11);

    // Store
    const [record] = await db.insert(apiKeys).values({
      userId,
      orgId,
      name,
      keyHash,
      keyPrefix,
      scopes,
      createdAt: new Date()
    }).returning({ id: apiKeys.id });

    return { key, id: record.id };
  }

  async validateKey(key: string): Promise<{
    valid: boolean;
    userId?: string;
    orgId?: string;
    scopes?: string[];
  }> {
    const prefix = key.substring(0, 11);

    // Find by prefix
    const records = await db
      .select()
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.keyPrefix, prefix),
          isNull(apiKeys.revokedAt)
        )
      );

    for (const record of records) {
      if (await bcrypt.compare(key, record.keyHash)) {
        // Update last used
        await db
          .update(apiKeys)
          .set({ lastUsedAt: new Date() })
          .where(eq(apiKeys.id, record.id));

        return {
          valid: true,
          userId: record.userId,
          orgId: record.orgId,
          scopes: record.scopes
        };
      }
    }

    return { valid: false };
  }

  async revokeKey(keyId: string): Promise<void> {
    await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.id, keyId));
  }
}
```

## Related Documentation

- [Enterprise RBAC](ENTERPRISE_RBAC.md) - Permission integration
- [Database & Persistence](DATABASE_PERSISTENCE.md) - Token storage
- [Safety & Firewall](SAFETY_FIREWALL.md) - Auth-based policies
