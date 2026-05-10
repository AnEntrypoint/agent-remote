# agent-remote

Peer-to-peer remote shell over HyperDHT. No servers, no ports, no firewall configuration. Run commands on any machine from anywhere using a shared key seed.

Works as both a **CLI** (`npx agent-remote` / `bunx agent-remote`) and an **SDK** (`import { runCommand } from "agent-remote"`).

```
# On the remote machine
npx agent-remote --server --key my-shared-seed

# On your local machine
npx agent-remote --daemon &
npx agent-remote --run --key my-shared-seed whoami
```

`bunx agent-remote ...` and `bun x agent-remote ...` are equivalent — use whichever runtime is available.

---

## Quick start

The seed is a shared secret that both sides hash into the same Curve25519 keypair. Pick a strong one:

```
openssl rand -hex 16
# → e3b4f2a1c8d7e6f5a4b3c2d1e0f9a8b7
```

Then on the **remote** host:

```
npx agent-remote --server --key e3b4f2a1c8d7e6f5a4b3c2d1e0f9a8b7
```

And on your **local** host:

```
npx agent-remote --daemon &
npx agent-remote --run --key e3b4f2a1c8d7e6f5a4b3c2d1e0f9a8b7 "uname -a"
```

Verify a seed without connecting:

```
npx agent-remote --pubkey --key e3b4f2a1c8d7e6f5a4b3c2d1e0f9a8b7
```

---

## SDK use

```js
import { runCommand, runServer, deriveKeyPair, startDaemon, rpc, connectTo } from "agent-remote";

// Side A: host the shell
await runServer("my-shared-seed");

// Side B: one-shot command
const { stdout, stderr, exitCode } = await runCommand("my-shared-seed", "ls -la");

// Verify deterministic keypair derivation
const { keyPair } = await deriveKeyPair("my-shared-seed");
console.log(keyPair.publicKey.toString("hex"));
```

The same shared seed always produces the same keypair on any machine, any runtime (Node or Bun), any version — `sha256(seed) → DHT.keyPair(seed)`.

---

## Claude Code skill

Install a Claude Code skill that teaches an agent how to use this tool:

```
npx agent-remote --install-skill /path/to/project
```

This writes `<project>/.claude/skills/agent-remote/SKILL.md`. The skill instructs the agent to use `npx agent-remote` (or `bunx agent-remote`) and gives the exact command to hand to the user for the remote side.

---

## How it works

```
[local daemon] ──RPC──▶ [runCommand]
                              │
                    derive keypair from seed (sha256 → DHT.keyPair)
                              │
                    DHT node.connect(pubkey)
                              │
                    Noise Protocol handshake (XX)
                              │
                    Protomux channel (protocol: "hypershell")
                              │
                    server spawns shell, pipes stdio
                              │
                    stdout/stderr stream back, exit code propagated
```

HyperDHT provides peer discovery, NAT traversal via UDP holepunching, and end-to-end Noise encryption. No DNS, no IPs, no port forwarding.

| Platform | Shell | Default |
|----------|-------|---------|
| Windows | `%COMSPEC%` | `cmd.exe` |
| Unix | `$SHELL` | `/bin/sh` |

---

## CLI reference

```
npx agent-remote --server --key <seed>          Run on REMOTE machine (listens on DHT)
npx agent-remote --daemon                       Start local RPC daemon (LOCAL side)
npx agent-remote --run --key <seed> <cmd...>    Run a command on the remote (LOCAL side)
npx agent-remote --shutdown                     Stop the local daemon
npx agent-remote --pubkey --key <seed>          Print derived public key
npx agent-remote --install-skill <dir>          Install Claude Code skill to <dir>/.claude/skills/
```

---

## RPC API

The local daemon exposes JSON-RPC at `http://127.0.0.1:<port>/rpc`. The port is in `$TMPDIR/agent-remote.port`.

| Method | Params | Returns |
|--------|--------|---------|
| `run` | `{ key, cmd }` | `{ stdout, stderr, exitCode }` |
| `connect` | `{ key }` | `{ id }` |
| `disconnect` | `{ id }` | `{ ok }` |
| `connections` | — | `{ ids }` |
| `shutdown` | — | `{ ok }` |

---

## Security

- All traffic is end-to-end encrypted via Noise Protocol.
- A valid keypair (derived from the seed) is required to open a shell channel.
- **The seed is effectively a password.** Treat it like one — generate fresh per session, do not log, do not commit.
- The local RPC daemon binds only to `127.0.0.1`; any local process can call it.

---

## Stack

| Layer | Package |
|-------|---------|
| DHT | `hyperdht` |
| Multiplexing | `protomux` |
| Shell protocol | `hypershell` |
| Key encoding | `hypercore-id-encoding` |
| Encoding | `compact-encoding` |
| Local IPC | `node:http` |
