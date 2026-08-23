# PRD — "Slice" (working title)

**A personal agent control plane with a computer for every agent.**
Tagline: *Share your computer with your teammate, or deploy to a server for a seamless always-on experience.*

| | |
|---|---|
| Status | Draft v0.1 |
| Author | Founder |
| Date | August 2026 |
| Basis | Fork of CopilotKit/openbot (MIT), CopilotKit Intelligence removed |
| Audience | Founder, early contributors, design partners |

---

## 1. Summary

Slice is a self-hosted platform where AI agents are governed profiles, not code. Each agent gets a real computer of its own — a browser with its own logins, a workspace, and only the tools it has been granted — running in an isolated VM on your Mac, on a teammate's Mac, or on an always-on Linux server. A single control plane holds everything the agent needs to exist: model provider, harness, skills and context files, MCP connections, credentials, and boundaries. Every action an agent takes is decided by policy before it happens and recorded after.

The product merges two things that exist separately today: the governed computer-per-agent runtime (pioneered by OpenBot) and the personal control plane for agent identity, secrets, and configuration (which no one ships for individuals and small teams). The wedge is a person with multiple harnesses, scattered API keys, and a desire to hand real work to agents they can actually trust with access. The expansion is a team of two to ten sharing compute and agents across a small mesh of machines.

## 2. Problem

Individuals and small teams running agents in 2026 face five compounding problems, none of which enterprise tooling solves at their scale:

**Credential sprawl.** SSH keys, API keys, OAuth tokens, and env vars live in dotfiles, shell profiles, and per-harness config, duplicated across machines. Rotating one key breaks an unknown number of agents. No inventory exists.

**Config sprawl.** Skills, CLAUDE.md/AGENTS.md files, agent definitions, and MCP server configs are copy-pasted between Claude Code, Cursor, OpenCode, and cloud agents. There is no versioning, no sync, and no single source of truth.

**Untrusted execution.** Agents run on the user's own machine with the user's own ambient permissions, or in a vendor cloud with the vendor's rules. There is no middle: *my* infrastructure, *my* policy, real isolation.

**No always-on option that isn't a vendor.** Long-running or scheduled agents require either leaving a laptop open or surrendering the workload to a hosted platform. Deploying to one's own server means assembling a stack by hand.

**No small-team story.** Sharing an agent, a skill, or spare compute with one teammate today means sharing credentials or screen-sharing. Enterprise control planes (Obot, MintMCP, AgentCore, Microsoft) assume platform teams, SSO, and Kubernetes; nothing serves n=1–10.

## 3. Who it's for

**P1 — The multi-harness power user (primary, launch).** A developer or technical operator who uses two or more agent harnesses, holds 10+ service credentials, owns a capable Apple silicon Mac and possibly a VPS, and wants agents to do real unattended work. Buys on day one because the product removes daily friction. The founder is this user.

**P2 — The two-to-ten person team (expansion).** A small company or working group where P1 users want to share agents, skills, and compute. One member's Mac or a shared Linux box becomes the team's agent infrastructure. No IT department; must work with Google sign-in and invites.

**Explicit non-target (v1):** enterprises needing SAML/SCIM, compliance reports, or managed support. The architecture should not preclude them; the product should not chase them yet.

## 4. Positioning

| Alternative | What it is | Why Slice wins for the target user |
|---|---|---|
| OpenBot (upstream) | Alpha computer-per-agent platform, AG-UI agents, CopilotKit Intelligence dependency | Slice removes the vendor dependency, adds harness/provider/config management, adds multi-node compute sharing and Mac-native runtime |
| Obot, MintMCP, Portkey, Lunar | Enterprise MCP gateways / control planes | Priced, packaged, and architected for platform teams; no computer-per-agent runtime; no personal-scale UX |
| Teleport | Infra identity + MCP access for enterprises | Enterprise pricing; no agent runtime, no config sync, not viable at n=1 |
| Meta-harnesses (Omnigent) | Unified environment above harnesses | Forces users into a new environment; no isolation, no compute mesh, no vault |
| DIY (dotfiles + Docker + Vault) | What P1 does today | The problem statement |

**Differentiation in one line:** the only product where an agent's identity, secrets, context, and *computer* are one governed object that can run on any machine you or your team owns.

## 5. Product principles

1. **Neutral by design.** Any provider, any harness, any AG-UI agent, any runtime backend. The product's value is the plane, never lock-in to a layer below it.
2. **Fail closed.** Missing policy permits nothing. A broken rule refuses rather than opens. Deny evaluates before allow. (Inherited from upstream; non-negotiable.)
3. **Secrets never enter the sandbox.** Credentials are write-only, encrypted at rest, injected at egress, redacted from transcripts and audit. An agent — or a prompt injection — cannot read what it never receives.
4. **Every action decided before, recorded after.** No path exists from an agent to a computer, file, MCP server, or component that bypasses the gateway and audit row.
5. **Local-first, mesh-second.** Fully functional on one Mac with no account and no internet dependency beyond model APIs. Sharing and servers extend the same system; they don't gate it.
6. **The agent is configuration.** Creating, editing, cloning, and moving an agent never requires writing code.

## 6. Core object model

**Node.** A machine enrolled in the mesh: a Mac (Apple `container` backend), a Linux server (Docker/gVisor backend), or later others. A node runs the supervisor, advertises its slice, and accepts computer placements. Nodes connect over a private tailnet.

**Slice.** The compute budget a node's owner dedicates to agents: cores, RAM, disk, and optionally hours ("agents may use 4 cores / 16 GB, always" or "…only 9pm–7am"). The supervisor enforces the slice as a hard pool; when it's full, placements queue or fail loudly.

**Profile.** The portable definition of an agent: provider + model routing, harness (or AG-UI endpoint), skills and context artifacts, MCP grants, credential grants, boundaries, and placement preferences. Profiles are versioned; an agent is a running instance of a profile.

**Computer.** An isolated VM/container instance bound to one agent: Chromium with a persistent profile, a `/workspace` volume, and a per-computer token. Computers are disposable; workspaces and browser profiles persist and can migrate between nodes.

**Vault.** Write-only encrypted credential store. Credential types: env var, API key, OAuth token set, SSH key, HTTP header. Each credential carries injection rules (which egress destinations may receive it) and grant lists (which profiles may cause its use).

**Artifact.** A versioned unit of agent context: a skill, a CLAUDE.md/AGENTS.md, an agent definition, an MCP server config. Artifacts have owners, versions, and provenance; profiles reference them by version or "latest."

**Boundary.** A CEL policy rule scoped to a profile, node, or the deployment, evaluating tool name, intent, actor, page URL/host, element, file, and MCP fields. (Inherited from upstream.)

**Channel / Coworker UX.** The upstream conversation surface: each agent is a coworker with a channel, a live screen, take-the-wheel handoff, and component-based responses. Preserved as-is.

**Grant.** The join object connecting a principal (user, profile) to a capability (credential, MCP tool, component, node slice) with scope and TTL.

## 7. Requirements

Priorities: **P0** = must ship in the milestone noted; **P1** = fast-follow; **P2** = later.

### 7.1 Foundation (fork surgery) — Milestone M0

- P0 — Fork OpenBot under MIT with attribution preserved; audit for any non-MIT vendored code.
- P0 — Remove CopilotKit Intelligence: implement durable threads, messages, and agent memory in Postgres (Drizzle migrations; pgvector for memory recall). Delete `INTELLIGENCE_*` requirements and the license-token gate from server startup.
- P0 — Retain AG-UI protocol support unchanged.
- P0 — Real authentication on by default for any non-loopback deployment: Better Auth + Google OAuth (upstream path), `OPENBOT_DEV_NO_AUTH` allowed only when bound to loopback.
- P1 — Passkey/local-account auth so the product works with zero Google dependency.

**Acceptance:** stock UX runs end-to-end (channel chat, browser task, audit, boundaries) with no external service other than the model API.

### 7.2 Runtime & supervisor abstraction — Milestone M1

- P0 — Define the Supervisor Contract as a versioned HTTP API: `create/destroy/list computer`, `attach workspace`, `exec`, `screen stream endpoint`, `health`, `capacity`. The server must treat any conforming supervisor as valid.
- P0 — Reference backend: Docker/Podman with gVisor (`runsc`) preserved, proven by swapping the new supervisor into the stock stack with zero behavior change.
- P0 — Slice enforcement in the supervisor: pool budget for cores/RAM/disk, per-computer caps, queue-or-refuse on exhaustion, live utilization reporting to the UI.
- P1 — Snapshot/restore of a computer's workspace + browser profile as a portable bundle (the migration primitive).

### 7.3 Mac runtime — Milestone M2

- P0 — Apple `container` / Containerization backend: one lightweight VM per computer on Apple silicon (macOS 26 for full networking), managed programmatically by a Swift sidecar or CLI orchestration.
- P0 — Setup flow: "Dedicate a slice of this Mac to agents" — pick cores/RAM/disk (and optional schedule) during onboarding; revisitable in settings.
- P0 — Persistent volumes for `/workspace` and browser profiles across throwaway VMs.
- P0 — Same OCI computer image as the Linux backend (Chromium + workspace + token guard), so streaming and CDP paths are identical.
- P1 — Menu-bar presence: slice utilization, running agents, pause-all.
- P2 — macOS guest VMs for native-app automation (Virtualization.framework; respects Apple's two-instance limit). Out of scope for v1.

### 7.4 Linux always-on runtime — Milestone M2

- P0 — One-command installer for a fresh Ubuntu/Debian server: Docker + gVisor, systemd units with restart policies, health checks, migrations, and enrollment into the mesh.
- P0 — Tailnet-only access by default (Tailscale or Headscale); no public ports. Documented reverse-proxy path (Caddy) for users who insist on public exposure.
- P0 — Nightly Postgres backups (pg_dump to local path or S3-compatible target) with documented restore; the DB holds credentials, audit, and threads and is treated as the crown jewels.
- P1 — Unattended OS/security updates guidance; disk-pressure and health alerts to the UI.

### 7.5 Mesh: share your computer, deploy to a server — Milestone M3

This is the headline. A deployment is one logical control plane spanning many nodes.

- P0 — Node enrollment: from the UI, generate a one-time enrollment token; run one command (Mac or Linux) to join the node to the deployment over the tailnet. Nodes appear in `/admin/nodes` with slice, capacity, health, and placement toggle.
- P0 — Teammate invites: invite by email → Google sign-in → role (admin / member). Members get their own credential vault entries, their own agents, and only the grants they're given.
- P0 — Slice sharing: a node owner may mark their slice shareable with the team (all members or named members), with a per-guest sub-budget. Guest agents on a shared node are subject to the *node owner's* node-level boundaries in addition to their own — the owner's machine, the owner's floor.
- P0 — Placement: profiles declare preferences (`always-on`, `burst`, `pinned:<node>`); the server places computers on eligible nodes with capacity, and the UI always shows *where* an agent is running.
- P0 — Seamless roaming: "Move to server" on any agent migrates its workspace + browser profile bundle to another node and resumes the channel. Target: under 60 seconds for a typical workspace; the channel, history, and audit are node-independent by construction.
- P1 — Offline handling: when a Mac node sleeps or leaves, its agents show as suspended; optionally auto-migrate `always-on` profiles to a server node.
- P1 — Per-node audit filtering and per-node kill switch ("evict all guest agents now").
- P2 — Cross-team sharing of published profiles/artifacts (a registry beyond one deployment).

### 7.6 Config pane (the control plane) — Milestone M4

- P0 — Provider management: register model credentials (Anthropic, OpenAI, Google, OpenRouter, custom OpenAI-compatible); per-profile model routing with fallbacks; per-profile and per-deployment token/cost budgets with live spend display. Provider keys are vault credentials injected at egress — never mounted into computers.
- P0 — Harness picker: a profile's runtime is either an AG-UI endpoint (upstream behavior) or a managed harness (Claude Code, OpenCode at launch) installed in the computer image with the profile's artifacts mounted and a thin AG-UI adapter wrapping its stream.
- P0 — Artifact registry: create/import skills, CLAUDE.md/AGENTS.md, and MCP configs as versioned artifacts; attach to profiles; diff and roll back.
- P1 — Local sync agent: a small CLI/daemon that projects a profile's artifacts into local harness config dirs (`~/.claude`, project `.claude/`, OpenCode config) — the answer to config sprawl on the user's own laptop, not just in cloud computers.
- P1 — MCP management upgraded: per-profile grants with read/write classification (inherited), plus credentialed MCP servers drawing from the vault.
- P2 — SSH key management: vault-held keys usable by agents only through a gateway-brokered SSH proxy (never raw key material in the computer); per-host grants and session recording.

### 7.7 Security & governance (cross-cutting, every milestone)

- P0 — All upstream guarantees preserved and covered by tests: single gateway path, CEL fail-closed policy, audit-before-act, write-only credentials, secret redaction, take-the-wheel, loopback + per-computer tokens.
- P0 — Egress credential injection for provider keys and MCP credentials: the computer sees placeholders; substitution happens at the gateway/proxy.
- P0 — Delegation records: every computer action row carries `user → profile → (sub-agent) → tool` attribution.
- P1 — Approval inbox: boundaries may return `require_approval`; pending actions surface in UI (and P2: push/Slack), approve/deny resumes or refuses the agent.
- P2 — Attenuating sub-agent grants (a spawned sub-agent's grants are a strict subset of its parent's).

## 8. Key user journeys

**J1 — Solo setup (M2).** Download on a Mac → dedicate a slice (e.g. 4 cores / 16 GB) → add one provider key → create a coworker from a template profile → watch it complete a browsing task on its own screen → open the audit log and see every decided action. Time to first governed task: under 15 minutes.

**J2 — Deploy to a server (M2–M3).** From settings, "Add a server" → copy one command onto a VPS → node appears with its slice → move an always-on agent to it → close the laptop; the agent keeps working; the channel is identical from the phone over the tailnet.

**J3 — Share with a teammate (M3).** Invite by email → teammate signs in, adds their own keys to their own vault → owner marks their Mac's slice shareable with a 2-core sub-budget → teammate's research agent runs on the owner's Mac, inside the owner's node boundaries, with every action attributed and auditable by both.

**J4 — One profile, any harness (M4).** Duplicate a profile, switch its harness from the AG-UI bot to Claude Code, keep the same skills, MCP grants, and boundaries → same coworker UX, same governance, different engine.

## 9. Non-goals (v1)

- Enterprise identity (SAML/SCIM/Okta), compliance certifications, managed cloud offering.
- A general PaaS: Slice runs *agent computers*, not arbitrary user services. (REST→MCP tool registration of externally deployed services is future work, not v1.)
- macOS guest VMs / native-app automation (P2 behind the two-instance limit).
- Sharing consumer *subscription* OAuth (Claude Max, ChatGPT plans) across harnesses or nodes — likely ToS-violating; provider support is API-key and router based only.
- Windows nodes; Intel Macs (Apple runtime is Apple-silicon-only).
- Model hosting or inference.

## 10. Architecture summary

Services (fork baseline → target): React/Vite app; Hono API server (auth, policy, audit, vault, artifacts, profiles, channels, placement); Postgres + pgvector (all product data including threads and memory — no external persistence service); per-node **supervisor** implementing the Supervisor Contract with a backend per OS (Apple Containerization on macOS; Docker/gVisor on Linux); OCI **computer image** shared across backends; tailnet for all node↔server and client↔server traffic.

The gateway remains the only action path: agent → server gateway → policy (CEL, fail closed) → audit row → computer/MCP/egress proxy with credential injection. The Supervisor Contract is the portability boundary; the vault + egress proxy is the security boundary; the profile is the product boundary.

## 11. Milestones

| Milestone | Scope | Exit criteria |
|---|---|---|
| M0 — Sovereign fork | 7.1 | Full upstream UX with zero external dependencies beyond model APIs; auth on |
| M1 — Supervisor contract | 7.2 | Own supervisor swapped in on Docker/gVisor, no behavior change; slice enforced |
| M2 — Two runtimes | 7.3, 7.4 | Same agent runs on a Mac slice and a hardened server; J1 and J2 pass |
| M3 — Mesh | 7.5 | Enrollment, invites, slice sharing, placement, sub-60s roaming; J3 passes |
| M4 — Control plane | 7.6 | Provider routing, harness picker, artifact registry; J4 passes |
| M5 — Hardening & fast-follows | P1 items | Approval inbox, local sync agent, offline auto-migration, backups drilled |

Sequencing rule carried over from planning: M1 is proven against the known-good Docker runtime *before* the Apple backend exists, so runtime bugs and supervisor bugs are never conflated.

## 12. Success metrics

Personal phase: founder retires dotfile-managed keys entirely (0 credentials outside the vault); ≥3 agents running weekly across ≥2 nodes; 30 consecutive days of always-on operation without manual intervention; credential rotation takes <2 minutes with zero broken agents.

Product phase (if pursued): time-to-first-governed-task <15 min for outside testers; ≥5 design-partner deployments with ≥2 nodes each; ≥1 team using slice sharing weekly; zero incidents of secret material reaching a transcript, audit row, or computer filesystem (standing invariant, tested in CI).

## 13. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Upstream divergence: OpenBot evolves fast or CopilotKit ships the same vision | Wasted merge effort or competitive squeeze | Propose the Supervisor Contract upstream early; keep the fork's diff concentrated in persistence + supervisor + config pane; be prepared to rebase or to diverge deliberately |
| Apple runtime immaturity (no compose, throwaway VMs, macOS 26 requirement, networking edge cases) | M2 slips | M1 contract proven on Docker first; Apple backend is additive; document macOS 15 limitations |
| Shared-node trust: a teammate's agent misbehaves on my Mac | Trust collapse of the headline feature | Node-owner boundaries always apply to guests; per-guest sub-budgets; per-node kill switch; full attribution in audit |
| Vault/DB compromise on a self-hosted box | Catastrophic for the user | Tailnet-only default, encryption at rest, write-only reads, documented backup + restore, no public ports in any quickstart |
| License/IP: residual non-MIT code or CopilotKit trademarks | Legal exposure | M0 includes a license audit; rename fully; keep attribution |
| Scope gravity toward enterprise | Product loses its wedge | Non-goals enforced in review; P2 gate on anything requiring SSO |
| Model-provider ToS (subscription auth sharing) | Account bans, liability | Explicit non-goal; API-key and router auth only |

## 14. Open questions

1. Name and trademark clearance for the working title.
2. Tailscale (hosted) vs Headscale (self-hosted) as the default mesh — convenience vs purity.
3. Harness adapter depth for v1: is wrapping Claude Code's stream in AG-UI sufficient for take-the-wheel semantics, or does the harness need first-class pause/resume hooks?
4. Migration fidelity: does a moved browser profile keep sessions alive across nodes reliably enough to promise "seamless," or should J2 set expectations to "re-login once per node"?
5. Monetization if productized: open-core (mesh features paid?), hosted control plane with self-hosted nodes, or pure OSS + support.
6. Whether to upstream M0–M1 as PRs before forking hard.
