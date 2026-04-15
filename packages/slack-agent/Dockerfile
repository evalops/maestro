# Slack Agent Sandbox Container
# Provides an isolated environment for AI agent code execution

FROM node:20-slim

# Install essential development tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    wget \
    jq \
    ripgrep \
    fd-find \
    tree \
    less \
    vim-tiny \
    ca-certificates \
    openssh-client \
    build-essential \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/bin/fdfind /usr/bin/fd

# Create non-root user for security
RUN groupadd --gid 1000 agent \
    && useradd --uid 1000 --gid agent --shell /bin/bash --create-home agent

# Set up workspace directory
RUN mkdir -p /workspace && chown agent:agent /workspace

# Set working directory
WORKDIR /workspace

# Switch to non-root user
USER agent

# Default command - keep container running
CMD ["tail", "-f", "/dev/null"]

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD test -d /workspace || exit 1

# Labels
LABEL org.opencontainers.image.title="Slack Agent Sandbox"
LABEL org.opencontainers.image.description="Isolated execution environment for Slack AI agent"
LABEL org.opencontainers.image.source="https://github.com/evalops/composer"
