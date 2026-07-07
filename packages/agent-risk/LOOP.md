# agent-risk: the loop

agent-risk runs in two halves that meet at a **ledger**: a deterministic scan that
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

## 1. Discovery — *what tools are here?*

`sweep(root)` walks the directory and finds **targets**: the shallowest directory
in each branch carrying a marker (`package.json`, `pyproject.toml`, `mcp.json`,
`server.json`, `SKILL.md`, …). A folder of bare tool dirs with no markers falls
back to one target per immediate child. One row per tool — a skill pack stays one
target, not one per file.

→ ledger: one `scan` item per target.

## 2. Capability Map — *what can each tool do?*

`scanTarget` reads every text/code file under a target and produces **atoms** via
scan-core: content-regex signatures over raw text (URLs, secrets, exec idioms) plus
regex-callee classification on real code (`subprocess.run` → `EXEC.PROC`,
`fetch` → `NETW.HTTP`, `fs.readFileSync('~/.aws/credentials')` → `CRED.*`). Atoms
roll up to **capability families**: `NET · BROWSER · EXEC · LOAD · CRED · FSWRITE ·
INSTALL · AITM`. This is the always-complete substrate — the same detection data
(the taxonomy packs) the Python engine uses, read by anything.

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

→ ledger: one `review` item per self-sufficient target and per cross-skill pairing,
seeded with `state_label: new`. Deterministic findings are authoritative
detections — the loop never re-runs detection or invents findings.

## 4. Triage — *is each finding real, and what do we do?*

A ledger-driven ralph loop (the pi/opencode extension registers a `ledger` tool and
drives turns). For each `review` item the harness model:

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
