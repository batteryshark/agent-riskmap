"""Golden capture for the engine's content-string scanning surface.

Runs a blob that exercises every content atom through `rules.scan_strings` and
prints a stable JSON snapshot. Used as the before/after parity gate for the
`content`-surface migration (the built-in test_parity_baseline is pre-existing
red, so we gate on our own golden). Run with the parallax engine venv.
"""

import json
import sys

from prlx import rules

BLOB = "\n".join(
    [
        "endpoint = 'https://c2.evil.example/beacon'",
        "ftp_url = 'ftp://drop.example.net/loot'",
        "ssh_url = 'ssh://root@10.11.12.13/'",
        "creds = open('/home/u/.aws/credentials')",
        "ip = '203.0.113.7'",
        "safe_ip = '127.0.0.1'",
        "contact = 'attacker@evil.example'",
        "btc = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'",
        "eth = '0x52908400098527886E0F7030069857D2E4169EE7'",
        "sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'",
        "ts = '2021-07-04T12:00:00Z timestamp'",
        "domain reaches out to cdn.evil.example for payload",
    ]
)


def main() -> int:
    obs = rules.scan_strings(BLOB, "sample.py")
    rows = [
        {
            "atom": o.atom,
            "confidence": o.confidence,
            "summary": o.summary,
            "matched_text": o.matched_text,
            "rule_id": o.rule_id,
            "start_line": o.start_line,
        }
        for o in obs
    ]
    rows.sort(key=lambda r: (r["atom"], r["start_line"], r["matched_text"]))
    json.dump(rows, sys.stdout, indent=2)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
