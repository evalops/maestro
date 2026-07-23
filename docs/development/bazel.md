# Bazel Build

Maestro now has a Bazel surface for the repo build contract and for proving the
shared `bazel-rbe-dev` Buildfarm path. Cargo is the canonical native build and
release path; Bazel remains a repository-contract and remote-execution lane.

## Local Checks

Run the local Bazel graph:

```sh
make bazel-test
```

Check Bazel hygiene before opening a PR:

```sh
make bazel-check
```

## Dev Buildfarm Remote Execution

The `remote-gcp-dev` Bazel config points at the Deploy-owned
`bazel-rbe-dev-buildfarm` backend. Locally, the helper opens a short-lived
SSH/IAP tunnel to the same Buildfarm listener used by colocated CI runners:

```sh
make bazel-rbe-smoke
```

Trusted CI should run on the repo-scoped Buildfarm runner label
`evalops-maestro-internal-rbe` after Deploy has registered that runner through
`additional_bazel_buildfarm_runners`.
