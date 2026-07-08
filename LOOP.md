# agent-riskmap: the loop

agent-riskmap runs in two halves that meet at a **ledger**: a deterministic scan that
is *always complete* seeds the work, and a ledger-driven ralph loop that adds
*judgment* without ever deciding coverage. The agent can't skip a finding and can't
declare itself done. The ledger's `resume()` is the sole arbiter of completion.

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

## 1. Discovery: what is on this surface?

`discover(root)` walks the directory and finds **targets**, the elements of an
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
they appear, including inside a code tool's `.claude/`. A folder of bare tool dirs
with no markers falls back to one target per child.

→ ledger: one `scan` item per target.

## 2. Dimension profile: what can each skill do, and be tricked into?

`scanTarget` reads a target's text and produces two kinds of **hints**:
*atoms* via the scanner (content signatures + callee classification on real code and
shell command heads: `subprocess.run` → `EXEC.PROC`, `fetch` → `NETW.HTTP`,
`fs.readFileSync('~/.aws/credentials')` → `CRED.*`) and *instruction patterns*,
high-precision phrases matched over the prose (`--dangerously-skip-permissions`,
"delegate to Claude Code", "your inbox"). Both roll up to the **seven risk
dimensions** (see [RISK-TAXONOMY.md](./docs/RISK-TAXONOMY.md)): Action Authority ·
Data Access · Latent Capability · Guardrail Posture · Steerability · Reach ·
Persistence.

Atoms are the *precise* signals; patterns are *hints* for the semantic-heavy
dimensions atoms can't see (a markdown-only skill that describes delegating to an
autonomous agent has no code atoms, but the pattern catches it). Both are a
**pessimistic prior**, not a verdict.

## 3. Hazards & posture: what dangerous shapes exist?

Dimensions compose into **six hazards**, each two roles A × B:

| Hazard | A × B | Meaning |
|---|---|---|
| **EXFIL** | data × reach | read sensitive data, send it off-host |
| **COMMS** | outbound-authority × steerability | sends something you didn't intend |
| **DESTROY** | destructive-authority × steerability | destroys something you didn't intend |
| **GUARDRAIL** | latent × guardrail-bypass | runs code / delegates while bypassing safety |
| **RCE** | steerability × latent | untrusted input drives code execution |
| **PERSIST** | latent × persistence | standing autonomous capability |

A skill is **self-sufficient** when it fills both roles alone; two skills form a
**cross-skill pairing** when one fills A-only and the other B-only. **Posture is
pessimistic**: guardrail-bypass or autonomy on a capable skill defaults to
`critical`, and atom-backed capability is high blast while a prose *mention* is only
medium.

→ ledger: **one `review` item per skill** (worst-tier first), seeded with its
dimension profile as a `state_label: new` prior. Nothing is silently "inert." The
model reviews every skill; the deterministic pass never has the last word.

## 4. Triage: is each finding real, and what do we do?

A ledger-driven ralph loop, shipped as the pi and opencode extensions under
[`extensions/`](./extensions/README.md): the `agent_riskmap_scan` tool seeds the
ledger from the deterministic scan, the `ledger` tool adjudicates, and `resume()`
drives the turns. For each `review` item the harness model:

1. `ledger next` → the item; `ledger start`.
2. Reads the cited evidence (files/lines), follows the data/control flow.
3. Moves the domain lifecycle via `state_label` (orthogonal to `status`, so the
   loop driver ignores it):
   `new → evaluating → (confirmed | dismissed | gated | needs-human)`.
4. `ledger resolve` (real risk, with the abuse path + a gate), `accept`
   (false-positive, with rationale), or `block` (needs a human).

The loop continues while any item is `discovered`/`in_progress`. `resume()` returns
**complete** only when every item is terminal, so coverage is objective and
externally verifiable, not a promise. `state_label` gives full domain tracking (a
finding can move `evaluating → reviewed` while still non-terminal) without touching
termination.

## Why this shape

- **Coverage is guaranteed** by the deterministic scan + the ledger, not by the
  model remembering to look.
- **Judgment is bounded**: the model only decides *per finding*, never *when to
  stop*.
- **Durable**: the ledger writes atomically (temp + rename), so a long triage run
  survives crashes with a valid state file.
- **Portable**: the scanner and ledger are pure TypeScript reading the bundled
  ruleset. No subprocess, no external services.
