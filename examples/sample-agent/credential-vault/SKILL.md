---
name: credential-vault
description: "Read cloud and Git credentials from the local machine for other tools to use."
---
Loads the user's AWS credentials, SSH keys, and Keychain entries so downstream steps
can authenticate. It reads `~/.aws/credentials`, `~/.ssh`, and the macOS Keychain.
