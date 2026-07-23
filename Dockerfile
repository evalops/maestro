FROM rust:bookworm AS native
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY packages/tui-rs ./packages/tui-rs
COPY packages/control-plane-rs ./packages/control-plane-rs
COPY packages/maestro-rs ./packages/maestro-rs
COPY packages/ambient-agent-rs ./packages/ambient-agent-rs
COPY proto ./proto
COPY test/fixtures/codex/coding-tools-doctor-v1.json ./test/fixtures/codex/coding-tools-doctor-v1.json
RUN cargo build --release --locked -p maestro

FROM debian:bookworm-slim
# Self-hosted runners block plain HTTP apt. Seed CA trust from the bookworm
# build image; fall back to Verify-Peer=false only if apt still cannot fetch.
COPY --from=native /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && if ! apt-get update; then \
         apt-get -o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false update; \
       fi \
    && if ! apt-get install -y --no-install-recommends ca-certificates git; then \
         apt-get -o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false \
           install -y --no-install-recommends ca-certificates git; \
       fi \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=native /app/target/release/maestro /usr/local/bin/maestro
COPY packages/web/dist ./packages/web/dist
COPY skills ./skills
ENV MAESTRO_CONTROL_HOST=0.0.0.0 MAESTRO_WEB_REQUIRE_KEY=0 PORT=3000
EXPOSE 3000
ENTRYPOINT ["maestro"]
CMD ["web"]
