# Deixic Code browser assets

This directory contains the versioned browser bundle served by the native Rust runtime gateway. The bundle is intentionally committed so building, packaging, and running Deixic Code never requires a TypeScript or JavaScript toolchain.

`dist/index.html` is the asset entry point. Update the snapshot only as part of an explicit browser-client replacement; runtime and wire-protocol behavior belong in `packages/runtime-gateway-rs` and `packages/tui-rs`.
