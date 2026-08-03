FROM rust:bookworm AS native
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY packages/execpolicy-rs ./packages/execpolicy-rs
COPY packages/tui-rs ./packages/tui-rs
COPY packages/control-plane-rs ./packages/control-plane-rs
COPY packages/maestro-rs ./packages/maestro-rs
COPY packages/ambient-agent-rs ./packages/ambient-agent-rs
COPY packages/ai-rs ./packages/ai-rs
COPY proto ./proto
COPY test/fixtures/codex/coding-tools-doctor-v1.json ./test/fixtures/codex/coding-tools-doctor-v1.json
RUN cargo build --release --locked -p maestro

FROM debian:bookworm-slim
# Seed CA trust from the bookworm build image before switching apt to HTTPS.
COPY --from=native /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=native /app/target/release/maestro /usr/local/bin/maestro
COPY packages/web/dist ./packages/web/dist
COPY skills ./skills
# The image binds to every interface, so the control plane requires API-key
# auth. Supply a key at run time, for example:
#   docker run -p 3000:3000 -e MAESTRO_WEB_API_KEY="$(openssl rand -hex 32)" ghcr.io/evalops/maestro
# Do not add MAESTRO_WEB_REQUIRE_KEY=0 here: it is only honored for loopback
# binds and the server refuses to start when it is combined with 0.0.0.0.
ENV MAESTRO_CONTROL_HOST=0.0.0.0 PORT=3000
EXPOSE 3000
ENTRYPOINT ["maestro"]
CMD ["web"]
