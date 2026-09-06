# Release readiness

The `release.yml` publisher checks the release-test Identity session before any npm publication. GitHub release finalization also requires the installed registry replay canary to pass. Missing or expired credentials fail the run; they never disable the replay.

In the protected `npm-release` environment, configure:

- Secret `MAESTRO_RELEASE_TEST_ACCESS_TOKEN`: a valid access token for a dedicated release-test account, bound to a test workspace and scoped to `llm_gateway:invoke`.
- Variable `MAESTRO_RELEASE_TEST_ORG_ID`: that account's organization ID. Preflight rejects a token from another organization or without workspace scope.

The same credential is passed only to preflight and the installed replay step. Identity remains the authority for validity, revocation, organization, and workspace. Preflight calls the production introspection endpoint with a five-second deadline and refuses redirects. It sends no model request and prints no token or response body. Use the existing Identity credential lifecycle to renew the token before it expires; this workflow does not create or refresh accounts and does not use a maintainer's personal session.

For both `@evalops/deixic-code` and `@evalops/maestro`, npm trusted publishing should identify `evalops/maestro`, workflow `release.yml`, environment `npm-release`. The first publication of a new package may require an account owner to bootstrap it before that association can be configured.

npm can expose immutable version metadata before its package index. The publisher reconciles the exact tarball integrity through either endpoint, then waits up to five minutes for matching package-index metadata. A mismatch fails immediately. A timeout can be retried after propagation; never move a tag or replace an npm version to resolve it.
