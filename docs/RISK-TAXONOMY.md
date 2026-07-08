# Agent-Skill Risk Taxonomy

The risk model agent-riskmap profiles against: seven dimensions, six hazards, and a
pessimistic posture. It is a **hybrid** detector: cheap deterministic hints pre-score
every skill, and a semantic per-skill review confirms, refines, or downgrades. Grounded
in the hermes skill corpus (74 skills).

## Why a dimension model, not a code scan

Skills are mostly *instruction* artifacts, not code. Measured on the hermes corpus:

- **61 / 74 skills are markdown-only** (no code files). A pure callee analysis is off
  for prose, so 82% of the surface gets only a few content regexes.
- **52 / 74 came back "inert," and 50 of those are the markdown-only ones.** These are
  "safe" verdicts on skills that were read but never *understood*.
- The single most dangerous skill, `autonomous-ai-agents/claude-code`, scored **INERT**
  under a code-only scan. It instructs the agent to spawn Claude Code with
  `--dangerously-skip-permissions` and auto-accept the trust dialogs, which is an
  unsandboxed, permission-bypassed autonomous coding agent. Zero dangerous *code
  idioms*; all danger in the *instructions*.

Two failure modes bound the problem:

| approach | hermes result | why wrong |
|---|---|---|
| code-syntactic scan | 7 self-sufficient / 52 inert | misses instruction-encoded capability (too few) |
| naive keyword grep | 64 / 74 flagged | matches benign prose; `ascii-video` scored 6/6 on generic words (too many) |

The real signal is **between 7 and 64**. Reaching it needs dimensions defined
precisely enough that a detector can combine *cheap deterministic hints* with
*semantic judgment* (a model reading the skill), and reject keyword false positives.

## Level 1: Risk **dimensions** (the axes)

A skill is profiled along eight independent dimensions. The first three are *power*,
the fourth a *multiplier*, five and six are *exposure to untrusted control*, seven is
*duration*, and eight is *who you're trusting* (opaque third-party code).

| # | Dimension | The question | Severity driver |
|---|---|---|---|
| 1 | **Action Authority** | What outward, irreversible effects can it cause? (send, post, pay, delete, deploy, message people) | reversibility × reach (private note → public post → money) |
| 2 | **Data Access & Scope** | What sensitive data can it read? | sensitivity × breadth (one file → entire mailbox/keychain) |
| 3 | **Latent Capability / Delegation** | Does it extend the agent's power (run arbitrary code, spawn/delegate to other agents, install software, wrap new tools)? | generality (fixed op → arbitrary code) |
| 4 | **Guardrail Posture** | Does it weaken or bypass safety (permission bypass, sudo, auto-accept, disable protections)? | **multiplier** on 1-3 |
| 5 | **Steerability / Injection Surface** | Does it consume *untrusted content* (web, email, files, tool output, **MCP tool descriptions / resource bodies / server instructions**) that could carry instructions redirecting its authority? | this is the agent-native attack vector |
| 6 | **Reach / Connectivity** | Network egress + external services it can talk to. | where data can leave / instructions can enter |
| 7 | **Persistence / Autonomy** | Runs unattended, schedules, installs hooks/daemons, survives sessions? | turns a one-shot risk into a standing one |
| 8 | **Delegated Trust** | Are you handing power to an **opaque, mutable third party** you can't read — a remote/local MCP server that can change its surface, poison your context, or drive your inference/user? | **multiplier**; opaque + capable → pessimistic floor |

### Dimension 8 — Delegated Trust (MCP servers)

Skills, hooks, and prompts you can *read*. An MCP server you often cannot, especially
a remote one. `agent-riskmap mcp <config>` connects to each server as a client and
captures the **advertised surface** (protocol revision, capabilities, tools + schemas +
annotations, prompts, resources, and optionally resource bodies) without invoking any
tool. The server's tools map onto dimensions 1-6 like any capability; delegated-trust
adds what is *specific* to trusting a black box, as facets:

| Facet | Meaning | How detected |
|---|---|---|
| `trust:opaque` | no source — you can't read what it does | any live-probed server |
| `trust:volatile` | the advertised set can change per-call / per-caller | `listChanged` capability, remote transport, or a tool-search meta-tool |
| `trust:poisoning` | injects instructions into your context (tool descriptions, prompt templates, resource bodies, server `instructions`) | hidden-instruction patterns + invisible/bidi unicode |
| `trust:sampling` | can drive **your** inference (MCP `sampling`) | **actively probed** — the client advertises the capability and records any request the server makes during discovery (returning a safe canned reply) |
| `trust:elicitation` | can prompt **your** user (MCP `elicitation`) | **actively probed** — same mechanism; observed requests are recorded |

The probe advertises `sampling` / `elicitation` / `roots` and records what the server
*tries* to do to the client (a server that asks to run your model even during
discovery is a strong signal). It only observes discovery-time requests. A server
that samples only inside a tool call isn't seen, because we never invoke tools.

**Tool search** is a server feature: a progressive-disclosure meta-tool can hide the
real tools behind a search op. `--drive-search` drives it (read-only) to enumerate
them; otherwise the surface is flagged partial.

**The surface is header/caller-dependent.** A server can serve different tools to
different identities, which is why we take the whole `mcp.json` (with its headers) —
what we capture is the surface *for those headers*, and it is a **snapshot**. Treat
every captured string as untrusted data; a hostile server can hide behavior or serve
different content per caller. That is why delegated-trust raises the floor: you are
trusting code you can't read and can't pin.

Dimensions 5 and 6 stay separate axes on purpose. Inbound (untrusted content that can
steer) and outbound (where data and actions can go) are not the same thing: injection
drives Unauthorized Communication / Destructive Action, egress drives Exfiltration.
Merging them would collapse hazards that must stay distinct.

Code capability atoms populate a few dimensions as deterministic hints:

```
CRED.*                        → (2) Data Access            NETW.* / ARTF.URL   → (6) Reach
FSYS.WRITE/DELETE             → (1) Action Authority        EXEC.* / LOAD.*     → (3) Latent Capability
PKGM.INSTALL                  → (3) Latent Capability       PRST.* / TIME.SCHED → (7) Persistence
PRIV.* (sudo/token)           → (4) Guardrail Posture       AITM.*              → (5) Steerability
```

The atoms cover the *syntactic* corner of dimensions 2, 3, 6, and partially 1/4/7.
Dimensions **1 (authority), 2's *scope*, 5 (injection)** are largely **semantic**, so
they cannot be read off tokens.

## Level 2: **Hazards** (compositions)

A hazard is a dangerous *composition* of dimensions. A hazard is **self-sufficient**
(one skill holds all parts) or a **cross-skill pairing** (two co-enabled skills each
hold a part, harmless apart, an abuse path once co-enabled in one agent).

| Hazard | Composition | Meaning |
|---|---|---|
| **Data Exfiltration** | Data-Access(sensitive) × Reach(egress) | read sensitive data, send it off-host |
| **Unauthorized Communication** | Action-Authority(outbound: send / post / message / share) × Steerability(injection) | the agent sends something out you didn't intend, on an attacker's cue |
| **Destructive Action** | Action-Authority(destructive: delete / overwrite / revoke / drop) × Steerability(injection) | the agent destroys / overwrites something you didn't intend |
| **Guardrail Defeat** | Latent-Capability(code/delegation) × Guardrail-Bypass | spawn unsandboxed exec / bypass permissions |
| **Remote Code Execution** | Reach(untrusted input) × Latent-Capability(exec) | network input drives code execution |
| **Autonomous Persistence** | Latent-Capability × Persistence × Reach | standing, self-perpetuating autonomous authority |

The two that matter most both stem from **Action-Authority × Steerability**, the
prompt-injection→real-world-action chain. They are kept **separate on purpose**,
because they fail in fundamentally different ways:

- **Unauthorized Communication**: "sent something you didn't mean to." An email the
  agent reads tells it to forward your inbox; a web page tells it to post. *Outbound.*
- **Destructive Action**: "destroyed something you didn't mean to." A file/record the
  agent processes tells it to delete or overwrite. *Irreversible loss.*

Neither depends on secrets or code, only on the skill having outbound/destructive
authority and consuming untrusted content.

> **Domain risk is orthogonal, not a hazard.** *Financial* (money transfer, purchase),
> *medical*, *legal*, etc. are **domains** a skill operates in. They don't add a hazard
> type; they **raise the severity** of the hazards above (an unauthorized send of a wire
> transfer is far worse than an unauthorized tweet) and are exactly the kind of context
> the model must **reason over per skill**, not match. Tag domain as context; let it
> weight severity.

## Level 3: Severity / posture

```
blast_radius   = worst reachable hazard, scored by reversibility × sensitivity × reach
× steerability multiplier   (untrusted-input surface present → attacker can trigger it)
× guardrail multiplier      (bypass present → nothing stops it)
× autonomy multiplier       (persistence/unattended → it runs without a human in the loop)
→ posture tier: minimal / moderate / elevated / critical
```

**Multipliers default pessimistic ("critical until proven otherwise").** The
deterministic pass assumes every present multiplier *bites*: a capable skill with any
guardrail-bypass is `critical` by default; an unattended / autonomous capable skill is
`elevated`+ by default. Only the **semantic pass may downgrade**, and only with a
recorded rationale (e.g. "the `--dangerously-skip-permissions` path is gated behind an
explicit user confirmation," "the persistence is one-time setup, not standing
authority"). This mirrors the whole architecture: the deterministic floor is
conservative and high-recall, it never quietly under-rates, and the model earns every
reduction on the record. Risk is never downgraded silently.

## Detection method per dimension

What a cheap deterministic pass supplies as a **hint/prior**, and what only a
**semantic** read of the skill can decide:

| Dimension | Deterministic hint (cheap, a prior) | Semantic judgment (model reads the skill) |
|---|---|---|
| 1 Action Authority | a few verbs (FP-prone) + `FSYS.DELETE` | **primary**: what outward actions does it actually enable, how reversible |
| 2 Data Access | credential-path atoms (`~/.aws`, `CRED.*`) ✓ | **scope**: "reads your whole mailbox/calendar/keychain" |
| 3 Latent Capability | `EXEC/LOAD/PKGM.INSTALL`, `npm i -g claude-code` ✓ | does it *delegate authority* / grant arbitrary power |
| 4 Guardrail Posture | **high-signal phrases** (`--dangerously-skip-permissions`, "bypass permissions", "auto-accept", sudo) ✓✓ | intent / whether the bypass is load-bearing |
| 5 Steerability | weak (AITM marker only) | **primary**: does it consume untrusted content and act on it |
| 6 Reach | URLs, network calls, MCP endpoints ✓✓ | where specifically / to whom |
| 7 Persistence | `cron`/`launchd`/`tmux`/`TIME.SCHED` ✓ | is the persistence load-bearing for a hazard |

Reading the table: **dimensions 4 and 6 are cheap deterministic wins** (guardrail-bypass
phrases catch `claude-code` for free); **1, 2-scope, 5 are semantic-only**.
So the hybrid is not "semantic replaces deterministic." It is *deterministic
pre-scores every skill and catches the high-signal phrases; the model reads every
skill to fill the judgment dimensions and to reject keyword false positives
(`ascii-video`)*.

## Corpus validation (hermes, 74 skills)

- Dimension prevalence by keyword signal (crude, over-inclusive): action-authority
  64, reach 56, delegate/exec 51, data-access 48, persistence 45, guardrail-bypass 18.
- Calibration anchors:
  - `claude-code`, `codex`, `hermes-agent`: Latent-Capability(delegation) ×
    Guardrail-Bypass → **Guardrail Defeat**, the crown jewels.
  - `google-workspace`: Action-Authority(send/delete) × Data-Scope(whole Google
    account) → Unauthorized-Action + Exfiltration. The *authority* and *scope* are the
    real story.
  - `ascii-video`: scored 6/6 on generic words, no real risk term → the false
    positive the semantic pass must reject.

## Open questions

- Exact multiplier arithmetic (how many tiers each multiplier moves).
- Whether cross-skill pairing applies to every hazard uniformly or only the
  data/action ones.
