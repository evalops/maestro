#!/usr/bin/env tsx
import { canonicalMaestroPlatformReplayFixtureJson } from "../src/telemetry/maestro-platform-replay-fixture.js";

process.stdout.write(canonicalMaestroPlatformReplayFixtureJson());
