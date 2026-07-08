# Agent-Skill Risk Taxonomy

Status: design spec (v0.1). Drives the planned **hybrid** detector (deterministic
hints + semantic per-skill review). Grounded in the hermes skill corpus (74 skills).

## Why this exists — the gap in v1

agent-riskmap v1 models the **code-malware triad** — EXFIL / RCE / DROP over code
capability atoms (`NETW`, `CRED`, `EXEC`, `FSYS`, …). That is the right lens for
*code-bearing* targets (npm packages, MCP servers with real implementations), where
danger hides in obfuscated sinks a human skim would miss.

It is the **wrong primary lens for skills**, which are mostly *instruction* artifacts.
Measured on the hermes corpus:

- **61 / 74 skills are markdown-only** (no code files). The scanner's callee analysis
  is off for prose, so 82% of the surface got only a few content regexes.
- **52 / 74 came back "inert," and 50 of those are the markdown-only ones** — "safe"
  verdicts on skills we read but never *understood*.
- The single most dangerous skill, `autonomous-ai-agents/claude-code`, scored
  **INERT**. It instructs the agent to spawn Claude Code with
  `--dangerously-skip-permissions` and to auto-accept the trust dialogs — an
  unsandboxed, permission-bypassed autonomous coding agent. Zero dangerous *code
  idioms*; all danger in the *instructions*.

Two failure modes bound the problem:

| approach | hermes result | why wrong |
|---|---|---|
| code-syntactic scan (v1) | 7 self-sufficient / 52 inert | misses instruction-encoded capability (too few) |
| naive keyword grep | 64 / 74 flagged | matches benign prose — `ascii-video` scored 6/6 on generic words (too many) |

The real signal is **between 7 and 64**. Reaching it needs dimensions defined
precisely enough that a detector can combine *cheap deterministic hints* with
*semantic judgment* (a model reading the skill), and reject keyword false positives.

## Level 1 — Risk **dimensions** (the axes)

A skill is profiled along seven independent dimensions. The first three are *power*,
the fourth a *multiplier*, five and six are *exposure to untrusted control*, seven is
*duration*.

| # | Dimension | The question | Severity driver |
|---|---|---|---|
| 1 | **Action Authority** | What outward, irreversible effects can it cause? (send, post, pay, delete, deploy, message people) | reversibility × reach (private note → public post → money) |
| 2 | **Data Access & Scope** | What sensitive data can it read? | sensitivity × breadth (one file → entire mailbox/keychain) |
| 3 | **Latent Capability / Delegation** | Does it extend the agent's power — run arbitrary code, spawn/delegate to other agents, install software, wrap new tools? | generality (fixed op → arbitrary code) |
| 4 | **Guardrail Posture** | Does it weaken or bypass safety — permission bypass, sudo, auto-accept, disable protections? | **multiplier** on 1–3 |
| 5 | **Steerability / Injection Surface** | Does it consume *untrusted content* (web, email, files, tool output) that could carry instructions redirecting its authority? | this is the agent-native attack vector |
| 6 | **Reach / Connectivity** | Network egress + external services it can talk to. | where data can leave / instructions can enter |
| 7 | **Persistence / Autonomy** | Runs unattended, schedules, installs hooks/daemons, survives sessions? | turns a one-shot risk into a standing one |

**Continuity with v1:** the existing code atoms are not discarded — they become
*deterministic hints* that populate a few dimensions:

```
CRED.*                        → (2) Data Access            NETW.* / ARTF.URL   → (6) Reach
FSYS.WRITE/DELETE             → (1) Action Authority        EXEC.* / LOAD.*     → (3) Latent Capability
PKGM.INSTALL                  → (3) Latent Capability       PRST.* / TIME.SCHED → (7) Persistence
PRIV.* (sudo/token)           → (4) Guardrail Posture       AITM.*              → (5) Steerability
```

The atoms cover the *syntactic* corner of dimensions 2, 3, 6, and partially 1/4/7.
Dimensions **1 (authority), 2's *scope*, 5 (injection)** are largely **semantic** —
they cannot be read off tokens.

## Level 2 — **Hazards** (compositions)

A hazard is a dangerous *composition* of dimensions. This generalizes EXFIL/RCE/DROP
from code to the agent level. As in v1, a hazard is **self-sufficient** (one skill
holds all parts) or a **cross-skill pairing** (two co-enabled skills each hold a part).

| Hazard | Composition | Meaning | v1 coverage |
|---|---|---|---|
| **Data Exfiltration** | Data-Access(sensitive) × Reach(egress) | read sensitive data, send it off-host | partial — EXFIL, secrets only |
| **Unauthorized Action** | Action-Authority(outward) × Steerability(untrusted input) | attacker content steers the agent into acting on your accounts (send/post/pay) | **missed entirely** |
| **Guardrail Defeat** | Latent-Capability(code/delegation) × Guardrail-Bypass | spawn unsandboxed exec / bypass permissions | **missed** — `claude-code` |
| **Remote Code Execution** | Reach(untrusted input) × Latent-Capability(exec) | network input drives code execution | yes — RCE |
| **Destructive Action** | Action-Authority(destructive) × Steerability | tricked into delete / overwrite / transfer | **missed** |
| **Autonomous Persistence** | Latent-Capability × Persistence × Reach | standing, self-perpetuating autonomous authority | **missed** |

Four of six agent-native hazards are invisible to v1. **Unauthorized Action** is the
most important miss: it is the classic prompt-injection→real-world-action chain (an
email the agent reads tells it to forward your inbox; a web page tells it to post),
and it depends on Steerability × Authority — neither of which v1 detects.

## Level 3 — Severity / posture

```
blast_radius   = worst reachable hazard, scored by reversibility × sensitivity × reach
× steerability multiplier   (untrusted-input surface present → attacker can trigger it)
× guardrail multiplier      (bypass present → nothing stops it)
× autonomy multiplier       (persistence/unattended → it runs without a human in the loop)
→ posture tier: minimal / moderate / elevated / critical
```

The v1 posture formula (`blast × steerability`) is the special case where the only
multiplier is AITM. This generalizes it.

## Detection method per dimension — the hybrid blueprint

This table *is* the plan for the next build: what a cheap deterministic pass can
supply as a **hint/prior**, and what only a **semantic** read of the skill can decide.

| Dimension | Deterministic hint (cheap, a prior) | Semantic judgment (model reads the skill) |
|---|---|---|
| 1 Action Authority | a few verbs (FP-prone) + `FSYS.DELETE` | **primary** — what outward actions does it actually enable, how reversible |
| 2 Data Access | credential-path atoms (`~/.aws`, `CRED.*`) ✓ | **scope** — "reads your whole mailbox/calendar/keychain" |
| 3 Latent Capability | `EXEC/LOAD/PKGM.INSTALL`, `npm i -g claude-code` ✓ | does it *delegate authority* / grant arbitrary power |
| 4 Guardrail Posture | **high-signal phrases** (`--dangerously-skip-permissions`, "bypass permissions", "auto-accept", sudo) ✓✓ | intent / whether the bypass is load-bearing |
| 5 Steerability | weak (AITM marker only) | **primary** — does it consume untrusted content and act on it |
| 6 Reach | URLs, network calls, MCP endpoints ✓✓ | where specifically / to whom |
| 7 Persistence | `cron`/`launchd`/`tmux`/`TIME.SCHED` ✓ | is the persistence load-bearing for a hazard |

Reading the table: **dimensions 4 and 6 are cheap deterministic wins** (guardrail-bypass
phrases would have caught `claude-code` for free); **1, 2-scope, 5 are semantic-only**.
So the hybrid is not "semantic replaces deterministic" — it is *deterministic
pre-scores every skill and catches the high-signal phrases; the model reads every
skill to fill the judgment dimensions and to reject keyword false positives
(`ascii-video`)*.

## Corpus validation (hermes, 74 skills)

- Dimension prevalence by keyword signal (crude, over-inclusive): action-authority
  64, reach 56, delegate/exec 51, data-access 48, persistence 45, guardrail-bypass 18.
- Calibration anchors:
  - `claude-code`, `codex`, `hermes-agent` — Latent-Capability(delegation) ×
    Guardrail-Bypass → **Guardrail Defeat**, the crown jewels. v1: inert / under-rated.
  - `google-workspace` — Action-Authority(send/delete) × Data-Scope(whole Google
    account) → Unauthorized-Action + Exfiltration. v1: an RCE/DROP hit from a script,
    but the *authority* and *scope* — the real story — are invisible.
  - `ascii-video` — scored 6/6 on generic words, no real risk term → the false
    positive the semantic pass must reject.

## How this changes the build (the hybrid, next)

1. **Seed the ledger with every skill** (coverage), each pre-scored by deterministic
   dimension hints — not only scanner-flagged findings. A skill v1 calls "inert" still
   gets reviewed.
2. **The model reviews each skill**: fills the seven dimensions, confirms/rejects the
   hints, identifies hazard compositions, assigns severity. The ledger guarantees every
   skill reaches a verdict (coverage stays objective; judgment stays per-skill).
3. **The deterministic scan stays authoritative for code-bearing targets** (packages,
   MCP-server code) — that half of the problem it already does well.
4. **Output** extends the existing report: a per-skill dimension profile + hazard list
   + the same restrict / prune / gate actions, now spanning agent-native risk.

Open questions for review before implementing the hybrid:
- Dimension set — are seven the right cut? (candidate merges: 5+6 as "exposure"?)
- Hazard list — is "Unauthorized Action" one hazard or split (comms vs financial vs
  destructive)?
- Severity weights — how much do the guardrail / autonomy multipliers move the tier?
