# Maestro browser assets

This directory contains the versioned browser bundle served by the native Rust control plane. The bundle is intentionally committed so building, packaging, and running Maestro never requires a TypeScript or JavaScript toolchain.

`dist/index.html` is the asset entry point. Update the snapshot only as part of an explicit browser-client replacement; runtime and wire-protocol behavior belong in `packages/control-plane-rs` and `packages/tui-rs`.
