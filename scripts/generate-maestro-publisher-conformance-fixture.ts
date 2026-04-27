#!/usr/bin/env tsx
import { canonicalMaestroPublisherConformanceFixtureJson } from "../src/telemetry/maestro-publisher-conformance-fixture.js";

process.stdout.write(await canonicalMaestroPublisherConformanceFixtureJson());
