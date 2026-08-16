FROM docker.io/lukemathwalker/cargo-chef:0.1.77-rust-bookworm@sha256:1689f62cfaa6603480356923cb5966544b2dd6ea523e30486bee4f149965d5bc AS chef
WORKDIR /app

FROM chef AS planner
COPY Cargo.toml Cargo.lock ./
COPY packages/execpolicy-rs ./packages/execpolicy-rs
COPY packages/tui-rs ./packages/tui-rs
COPY packages/scenario-rs ./packages/scenario-rs
COPY packages/control-plane-rs ./packages/control-plane-rs
COPY packages/maestro-rs ./packages/maestro-rs
COPY packages/runtime-rs ./packages/runtime-rs
COPY packages/ambient-agent-rs ./packages/ambient-agent-rs
COPY packages/ai-rs ./packages/ai-rs
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS native
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --locked -p maestro --recipe-path recipe.json
COPY Cargo.toml Cargo.lock ./
COPY packages/execpolicy-rs ./packages/execpolicy-rs
COPY packages/tui-rs ./packages/tui-rs
COPY packages/scenario-rs ./packages/scenario-rs
COPY packages/control-plane-rs ./packages/control-plane-rs
COPY packages/maestro-rs ./packages/maestro-rs
COPY packages/runtime-rs ./packages/runtime-rs
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
