# Stonefish Labs

Lightweight, dependency-free security tooling you can drop into your coding agent
— **[pi](https://pi.dev)** and **[opencode](https://opencode.ai)** — to try two
capabilities without a heavy runtime:

- **agent-risk** — what can my agent be tricked into, and what does it become once
  it holds these tools? (dangerous capability compositions: EXFIL / RCE / DROP)
- **mcd** — is this code doing something malicious, and can I prove it?
  (Malicious Code Detection)

A stonefish is venomous prey camouflaged as a harmless rock. So is the risk these
tools look for: the thing that reads benign until you look closely.

## Design

Pure TypeScript. No Python, no external services. The scanner reads the **same**
`parallax-signature-pack/v1` rule packs the upstream Parallax engine reads (from
the [`parallax-taxonomy`](../parallax-taxonomy) repo), so detection knowledge is
single-sourced, not forked.

```
@stonefish-labs/scan-core     shared primitives: signature-pack reader/matcher,
                              tree-sitter walkers (WIP), binary triage (WIP)
@stonefish-labs/agent-risk    readings + npx CLI            (WIP)
@stonefish-labs/mcd           readings + npx CLI            (WIP)
@stonefish-labs/*-pi          pi extension per product      (WIP)
@stonefish-labs/*-opencode    opencode tool per product     (WIP)
```

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test
```

Point the scanner at a taxonomy checkout with `PRLX_TAXONOMY_ROOT`, or keep
`parallax-taxonomy` as a sibling directory (auto-resolved).

Apache-2.0
