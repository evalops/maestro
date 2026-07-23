# Quickstart

Install Rust and Node.js for repository development. The browser UI is checked in as a versioned static snapshot; all product behavior is built from Rust.

```sh
npm install
npm run build
./bin/maestro --version
./bin/maestro
./bin/maestro web --port 3000
```

Run checks with:

```sh
npm run check:rust-only-runtime
npm run lint
npm test
```
