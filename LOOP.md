# agent-riskmap: the loop

agent-riskmap runs in two halves that meet at a **ledger**: a deterministic scan that
is *always complete* seeds the work, and a ledger-driven ralph loop that adds
*judgment* without ever deciding coverage. The agent can't skip a finding and can't
declare itself done — the ledger's `resume()` is the sole arbiter of completion.

```
      DETERMINISTIC (always complete)                 AGENTIC (judgment)
  ┌───────────┬──────────────┬────────────────┐   ┌────────────────────┐
  │ Discovery │ Capability   │ Classification │──▶│ Triage             │
  │           │ Map          │                │   │ (ledger ralph loop)│
  └───────────┴──────────────┴────────────────┘   └────────────────────┘
        │            │               │                      │
     targets      atoms          combos +              per-finding verdict
                (families)        posture              (state_label moves)
        └────────────┴───────────────┴─── seed ledger ─────▶ resolve items
```

## 1. Discovery — *what is on this surface?*

`discover(root)` walks the directory and finds **targets** — the elements of an
agent surface, each tagged with a **kind**:

| kind | what it is | how it's found |
|---|---|---|
| **skill** | a skill pack | `SKILL.md` |
| **tool** | a code tool / extension | `package.json`, `pyproject.toml`, … |
| **mcp** | an MCP server | `server.json`, or a reference in `settings.json` / `.mcp.json` (scanned via its launch command) |
| **hooks** | inline shell that auto-runs on agent events | `hooks` block in a settings file |
| **prompt** | instruction surface that can steer the agent | `CLAUDE.md`, `AGENTS.md`, `commands/` & `agents/` `.md` |

Structural markers claim a directory and stop recursion there (one skill pack = one
target, not one per file); settings and prompt files are additive and found wherever
they appear — including inside a code tool's `.claude/`. A folder of bare tool dirs
with no markers falls back to one target per child.

→ ledger: one `scan` item per target.

## 2. Capability Map — *what can each element do?*

`scanTarget` reads a target's text — files for skill/tool/prompt targets, the
command strings for hooks and MCP references — and produces **atoms** via scan-core:
content-regex signatures over raw text (URLs, secrets, `curl … | sh`) plus callee
classification on real code (`subprocess.run` → `EXEC.PROC`, `fetch` → `NETW.HTTP`,
`fs.readFileSync('~/.aws/credentials')` → `CRED.*`) and on **shell command heads**
(`curl` → `NETW.HTTP`, `rm` → `FSYS.DELETE`, `base64` → `XFRM.ENCODE`) — which is
what makes a hook or a `.sh` tool classify at all. Atoms roll up to **capability
families**: `NET · BROWSER · EXEC · LOAD · CRED · FSWRITE · INSTALL · AITM`. This is
the always-complete substrate — the same detection data (the taxonomy packs) the
Python engine uses, read by anything.

> Steerability note: today the `AITM` family fires only on a specific
> Unicode-confusable prompt-marker mechanic, so prompt targets are inventoried and
> capability-scanned but rarely raise steerability on generic "ignore previous
> instructions" prose. Generic prompt-injection phrase detection is the top planned
> enrichment (it belongs in the shared signature pack, with FP care).

## 3. Classification — *what dangerous shapes exist?*

Three abuse compositions, each a `source → sink` over families:

| Composition | Source | Sink | Meaning |
|---|---|---|---|
| **EXFIL** | `CRED` | `NET / BROWSER` | read secrets, then send them off-host |
| **RCE** | `NET / BROWSER` | `EXEC / LOAD` | network input drives code execution |
| **DROP** | `FSWRITE` | `EXEC / LOAD` | write a file, then execute it |

A target is **self-sufficient** when it holds both halves alone; two targets form a
**cross-skill pairing** when one is source-only and the other sink-only —
dangerous the moment both are co-enabled in one agent. **Posture** = blast radius
(capability severity) × steerability (any `AITM` surface) → `minimal / moderate /
elevated / critical`.

→ ledger: one `review` item per self-sufficient target and per cross-skill
**composition** (not per pairing — sources × sinks is combinatorial, but the
adjudication is a single decision: "are these real, and should they be
co-enabled?"), seeded with `state_label: new`. Deterministic findings are
authoritative detections — the loop never re-runs detection or invents findings.

## 4. Triage — *is each finding real, and what do we do?*

A ledger-driven ralph loop, shipped as the pi and opencode extensions under
[`extensions/`](./extensions/README.md): the `agent_riskmap_scan` tool seeds the
ledger from the deterministic scan, the `ledger` tool adjudicates, and `resume()`
drives the turns. For each `review` item the harness model:

1. `ledger next` → the item; `ledger start`.
2. Reads the cited evidence (files/lines), follows the data/control flow.
3. Moves the domain lifecycle via `state_label` — orthogonal to `status`, so the
   loop driver ignores it:
   `new → evaluating → (confirmed | dismissed | gated | needs-human)`.
4. `ledger resolve` (real risk, with the abuse path + a gate), `accept`
   (false-positive, with rationale), or `block` (needs a human).

The loop continues while any item is `discovered`/`in_progress`. `resume()` returns
**complete** only when every item is terminal — coverage is objective and
externally verifiable, not a promise. `state_label` gives full domain tracking
(a finding can move `evaluating → reviewed` while still non-terminal) without
touching termination.

## Why this shape

- **Coverage is guaranteed** by the deterministic scan + the ledger, not by the
  model remembering to look.
- **Judgment is bounded**: the model only decides *per finding*, never *when to
  stop*.
- **Durable**: the ledger writes atomically (temp + rename), so a long triage run
  survives crashes with a valid state file.
- **Portable**: scanner and ledger are pure TypeScript reading the same taxonomy
  data the Python engine reads — no Python, no subprocess.
