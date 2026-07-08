# agent-riskmap harness extensions

The CLI (`agent-riskmap <dir>`) runs only the **deterministic** half — it maps the
hazardous capability combinations and stops. These extensions add the **agentic
triage loop**: the scan seeds a ledger with every finding, then your harness model
adjudicates each one (reads the cited evidence, follows the flow, and
**confirms / dismisses / gates** it). The ledger owns termination — the model never
self-terminates and never invents findings.

```
agent_riskmap_scan(dir)        ledger tool (per finding)
   deterministic scan   ─────▶  start → read evidence → resolve | accept | block
   seeds N findings             state_label: new → evaluating → confirmed|gated|dismissed|needs-human
        │                              │
        └──────── ledger ◀─────────────┘   resume() ends the loop when all findings are terminal
```

Both extensions import the triage core from the package itself
(`@stonefish-labs/agent-riskmap/triage` and `/ledger`) — no subprocess, no Python.

## Pi

```sh
mkdir -p ~/.pi/agent/extensions/agent-riskmap
cp extensions/pi/index.ts ~/.pi/agent/extensions/agent-riskmap/index.ts
cp extensions/pi/package.json ~/.pi/agent/extensions/agent-riskmap/package.json
cd ~/.pi/agent/extensions/agent-riskmap && npm install   # pulls @stonefish-labs/agent-riskmap
```

Pi discovers it on next start. Then:

```
/agent-riskmap scan ~/.claude/plugins    # scan a surface, seed the ledger, start triage
/agent-riskmap status                    # show the ledger
/agent-riskmap stop                      # halt the loop
```

The model can also start a scan itself via the `agent_riskmap_scan` tool.

## OpenCode

Install `@stonefish-labs/agent-riskmap` where opencode can resolve it, then add to
`~/.config/opencode/opencode.json`:

```json
{ "plugin": ["@stonefish-labs/agent-riskmap/extensions/opencode/index.ts"] }
```

Then ask the agent to *"scan `<dir>` with agent-riskmap"* (or call the
`agent_riskmap` tool with `action: "scan"`). Triage runs to completion on idle.
`agent_riskmap` `action: "status" | "stop"` inspects or halts the loop.

## What the model does per finding

| verdict | when | ledger action | state_label |
|---|---|---|---|
| **resolve** | real / plausible abuse path | `resolve` + recommended gate | `confirmed` (or `gated` if already mitigated) |
| **accept** | false positive / not exploitable | `accept` + rationale | `dismissed` |
| **block** | needs a human policy decision | `block` + what's needed | `needs-human` |

The ledger writes atomically to `.ledger/state.json`, so a long triage run survives
a crash with a valid state file and resumes where it left off.
