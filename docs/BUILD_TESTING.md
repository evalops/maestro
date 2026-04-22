# Build Testing Guide

This document describes the comprehensive build testing infrastructure for Maestro.

## Overview

Build testing ensures that:
1. All build artifacts are present and valid
2. Type definitions are correctly generated
3. Source maps are valid
4. Essential modules and tools are built correctly
5. CLI functionality works after build
6. Package builds (TUI, Web, Contracts, AI) are complete

## Test Suites

### 1. Build Verification Tests (`test/build/build-verification.test.ts`)

Comprehensive unit tests that verify:
- Critical CLI artifacts exist (`cli.js`, `main.js`, `index.js`, `web-server.js`)
- Type definitions are present and non-empty
- Source maps are valid JSON
- Core module directories exist (`agent`, `tools`, `cli`, `models`, etc.)
- Essential tools are built (`read`, `write`, `edit`, `list`, `search`, `bash`, `diff`)
- File structure is consistent

**Run:** `bunx vitest --run test/build/build-verification.test.ts`

### 2. Package Build Tests (`test/build/package-builds.test.ts`)

Verifies that workspace packages build correctly:
- TUI package (`packages/tui/dist`)
- Web package (`packages/web/dist`)
- Contracts package (`packages/contracts/dist`)
- AI package (`packages/ai/dist`)

**Run:** `bunx vitest --run test/build/package-builds.test.ts`

### 3. Binary Compilation Tests (`test/build/binary-compilation.test.ts`)

Tests for the compiled binary (`dist/maestro-bun`):
- Binary exists (if compilation was run)
- Binary has correct size
- Binary compilation process works (when `TEST_BINARY_COMPILATION=1`)

**Run:** `TEST_BINARY_COMPILATION=1 bunx vitest --run test/build/binary-compilation.test.ts`

### 4. Smoke Tests (`scripts/smoke-cli.js`)

End-to-end CLI functionality tests:
- `--help` command works
- `--version` command works
- `--headless` emits only protocol JSON on stdout and completes a `hello`
  startup handshake
- Help output contains expected content
- File existence checks
- File content validation (shebang, size)
- Type definitions exist
- Source maps are valid
- Module directories exist
- Essential tools exist
- JSON mode works
- Models command works

**Run:** `bun run smoke` or `node scripts/smoke-cli.js`

Run only the headless stdio regression smoke with
`bun run smoke:headless` after `bun run build`.

### 5. Headless Responsiveness Harness (`scripts/headless-responsiveness-harness.js`)

The responsiveness harness is a lightweight signal for hosted-runner behavior.
It exercises an in-process mock runner and the built headless CLI, then emits
machine-readable JSON with startup, hello, prompt, event, and drain timings.
Use it for ADR evidence and gateway/substrate comparisons; correctness gates
belong in the headless protocol and smoke tests.

**Run:** `bun run headless:responsiveness` after `bun run build`

### 6. Build Verification Script (`scripts/verify-build.ts`)

Comprehensive build verification script that runs all checks:
- Critical files verification
- Type definitions verification
- Source maps verification
- Module structure verification
- Essential tools verification
- CLI functionality verification
- Package builds verification (optional, via `VERIFY_PACKAGES=1`)

**Run:**
- `bun run verify-build` (basic verification)
- `VERIFY_PACKAGES=1 bun run verify-build` (includes package verification)
- `npx nx run maestro:verify-build` (Nx target wrapper)

### 7. Platform SDK Contract Smoke (`scripts/check-platform-sdk-contract.ts`)

Cross-repo smoke test for the generated Platform TypeScript SDK before
`@evalops/sdk-ts` is available from npm. The script packs `gen/ts` from a
Platform checkout, runs Platform's SDK package smoke test, installs the tarball,
and verifies Maestro's core service paths against the generated descriptors.

**Run:** `MAESTRO_PLATFORM_REPO=/path/to/platform npm run platform:sdk-smoke`

## Usage

### Local Development

After building, verify your build:

```bash
# Build everything
npm run build:all

# Run build verification
bun run verify-build

# Run smoke tests
bun run smoke

# Run all build tests
bunx vitest --run test/build/
```

### Pre-Commit Checklist

Before committing, ensure:

```bash
# 1. Build everything
npm run build:all

# 2. Verify build artifacts
bun run verify-build

# 3. Run smoke tests
bun run smoke

# 4. Run full test suite
npx nx run maestro:test --skip-nx-cache
```

### CI Integration

Build verification is automatically run in CI:

- **Evals workflow** (`.github/workflows/evals.yml`):
  - Runs after `build:all`
  - Verifies build artifacts
  - Runs smoke tests
  - Then runs full test suite

- **Release workflow** (`.github/workflows/release.yml`):
  - Runs after build
  - Verifies build artifacts
  - Runs smoke tests
  - Ensures release builds are valid

## Nx Targets

New Nx targets for build verification:

```bash
# Verify build artifacts
npx nx run maestro:verify-build

# Run smoke tests
npx nx run maestro:smoke
```

## Troubleshooting

### Build Verification Fails

1. **Missing files**: Ensure `npm run build:all` completed successfully
2. **Empty files**: Check for build errors in the console
3. **Type definition issues**: Run `tsc --noEmit` to check TypeScript errors
4. **Source map issues**: Verify source maps are being generated in `tsconfig.build.json`

### Smoke Tests Fail

1. **CLI commands fail**: Check that `dist/cli.js` exists and is executable
2. **File not found**: Ensure build completed before running smoke tests
3. **Permission errors**: On Unix systems, ensure `dist/cli.js` has execute permissions

### Package Build Tests Fail

1. **Package dist missing**: Run `bun run --filter @evalops/<package> build` for the specific package
2. **Empty dist**: Check package-specific build errors
3. **Type definitions missing**: Verify package `tsconfig.json` includes declaration generation

## Best Practices

1. **Always run build verification after building** - Catch issues early
2. **Run smoke tests before committing** - Ensure CLI works
3. **Include build tests in CI** - Prevent broken builds from merging
4. **Test binary compilation separately** - Use `TEST_BINARY_COMPILATION=1` when needed
5. **Verify packages when changing workspace structure** - Use `VERIFY_PACKAGES=1`

## Future Improvements

Potential enhancements:
- Build performance regression detection
- Dependency bundle size tracking
- Cross-platform build verification
- Automated binary testing on multiple OS
- Build artifact checksums for integrity verification
