# Release readiness

The `release.yml` publisher checks the release-test Identity session before any npm publication. GitHub release finalization also requires the installed registry replay canary to pass. Missing or expired credentials fail the run; they never disable the replay.

In the protected `npm-release` environment, configure these variables:

- `MAESTRO_RELEASE_TEST_SESSION_SECRET`: the full Secret Manager resource containing the native Maestro OAuth session, for example `projects/evalops-prod/secrets/maestro-release-test-identity-session`.
- `MAESTRO_RELEASE_TEST_GCP_WORKLOAD_IDENTITY_PROVIDER`: the approved GitHub Actions WIF provider resource.
- `MAESTRO_RELEASE_TEST_GCP_SERVICE_ACCOUNT`: the dedicated rotator service account, for example `maestro-release-test@evalops-prod.iam.gserviceaccount.com`.
- `MAESTRO_RELEASE_TEST_ORG_ID`, `MAESTRO_RELEASE_TEST_WORKSPACE_ID`, and `MAESTRO_RELEASE_TEST_SUBJECT`: the exact organization, workspace, and Identity subject for the dedicated test account.

The Secret Manager payload is the native OAuth session (`type: "oauth"`, `access`, `refresh`, `expires`, and `metadata`). Enroll that account once through the approved Identity login flow, then store the resulting session as the first secret version. The workflow exchanges the one-use refresh token through `/v1/tokens/refresh`, saves the rotated session before introspection, and exposes only the fresh access token to the two same-job checks through `GITHUB_ENV`. Do not use a maintainer's personal session or the Conductor canary refresh token.

Identity remains the authority for validity, revocation, organization, and workspace. Preflight calls the production introspection endpoint with a five-second deadline and refuses redirects. It sends no model request and prints no token or response body. Missing, expired, revoked, or tenant-mismatched sessions fail closed before npm publication.

For both `@evalops/deixic-code` and `@evalops/maestro`, npm trusted publishing should identify `evalops/maestro`, workflow `release.yml`, environment `npm-release`. The first publication of a new package may require an account owner to bootstrap it before that association can be configured.

npm can expose immutable version metadata before its package index. The publisher reconciles the exact tarball integrity through either endpoint, then waits up to five minutes for matching package-index metadata. A mismatch fails immediately. A timeout can be retried after propagation; never move a tag or replace an npm version to resolve it.
