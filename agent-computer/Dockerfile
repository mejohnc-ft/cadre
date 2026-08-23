# The Bot's computer uses Playwright's image so Chromium and its system libraries stay matched.
#
# The image tag and Playwright dependency must be pinned to the same exact version. Bump both or
# neither.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

# unzip is not in the Playwright image and bun's installer needs it. The rest is the toolbox a
# Bot's shell actually earns its keep with: version control, a scripting runtime, search, JSON,
# and an editor for the person who takes the wheel. Kept to apt so the image stays reproducible.
RUN apt-get update && apt-get install -y --no-install-recommends \
    unzip git python3 python3-venv python3-pip \
    ripgrep jq sqlite3 less nano file zip \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# The managed harness. Claude Code's native installer, then the binary where the adapter finds it.
# IS_SANDBOX tells Claude Code it may run without its own permission prompts as root: this is a
# sandbox, and the deployment's policy — not Claude Code's prompts — decides every tool.
RUN curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1 \
  && cp /root/.local/bin/claude /usr/local/bin/claude && chmod 755 /usr/local/bin/claude
# The other managed harnesses, installed globally with bun so they are on PATH for the adapter.
RUN bun add -g @mariozechner/pi-coding-agent opencode-ai @openai/codex >/dev/null 2>&1 \
  && ln -sf /root/.bun/bin/pi /usr/local/bin/pi \
  && ln -sf /root/.bun/bin/opencode /usr/local/bin/opencode \
  && ln -sf /root/.bun/bin/codex /usr/local/bin/codex
ENV IS_SANDBOX=1
COPY agent-computer/hooks/slice-hook.sh /opt/slice/hook.sh
COPY agent-computer/hooks/pi-slice.mjs /opt/slice/pi-slice.mjs
COPY agent-computer/hooks/opencode-slice.js /opt/slice/opencode-slice.js
RUN chmod 755 /opt/slice/hook.sh

WORKDIR /app
# The lockfile as well as the manifest: `--frozen-lockfile` with no lockfile present resolves afresh
# and exits 0, so the file has to be here for the flag to mean anything.
COPY agent-computer/package.json agent-computer/bun.lock ./
RUN bun install --frozen-lockfile

COPY agent-computer/src ./src

# Durable working directory. Bot-produced files that must survive replacement live here.
RUN mkdir -p /workspace
ENV WORKSPACE_DIR=/workspace

ENV PORT=4100
EXPOSE 4100
# Readiness is exposed through Docker health so the supervisor need not know the network route.
HEALTHCHECK --interval=2s --timeout=3s --start-period=2s --retries=30 \
  CMD bun -e "const r = await fetch('http://localhost:4100/health'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "src/index.ts"]
