# agent-remote

Peer-to-peer remote shell over HyperDHT. No servers, no ports, no firewall configuration. Run commands on any machine from anywhere using a shared key seed.

```
bun x agent-remote --server --key myseed
bun x agent-remote --run --key myseed whoami
```

---

## How it works

### The pipeline

```
[local daemon] ──RPC──▶ [runCommand]
                              │
                    derive keypair from seed
                              │
                    DHT node.connect(pubkey)
                              │
                    Noise Protocol handshake
                              │
                    Protomux channel (protocol: "hypershell")
                              │
                    ShellClient sends: SHELL.bin SHELL.flag cmd
                              │
                    [remote server] spawns shell, pipes stdio
                              │
                    stdout/stderr streamed back over socket
                              │
                    channel close → result returned
```

### Key derivation

The `--key` seed is a human-readable string. It is SHA-256 hashed into a 32-byte seed, then passed to `DHT.keyPair(seed)` to produce a Curve25519 keypair. The public key is the server's address on the DHT — no DNS, no IPs.

```
"myseed" → sha256 → 32 bytes → { publicKey, secretKey }
```

Both client and server derive the same keypair from the same seed. The server listens on its keypair; the client connects to that public key.

### Transport

HyperDHT provides the peer discovery and connection layer:
- Nodes bootstrap via a public DHT network (holepunch.io bootstrap nodes)
- UDP holepunching traverses NAT without port forwarding
- All connections are end-to-end encrypted via the Noise Protocol (XX handshake)
- `Protomux` multiplexes logical channels over the single encrypted socket
- The `hypershell` protocol runs on one of those channels

### Shell detection

The daemon detects the shell at startup — once, from the environment:

| Platform | Source | Default |
|----------|--------|---------|
| Windows | `%COMSPEC%` | `cmd.exe` |
| Unix | `$SHELL` | `/bin/sh` |

Every `run` command is dispatched as `[shell, flag, cmd]` — whatever shell launched the daemon is the shell used for all commands. No configuration needed.

### Daemon architecture

The local daemon is a long-lived HTTP server on `127.0.0.1` at a random port. The port is written to `$TMPDIR/agent-remote.port` on startup and removed on shutdown. Each CLI invocation reads that file to find the daemon.

This mirrors the agent-browser pattern: the daemon pays the DHT bootstrap cost once, then each `run` call is an atomic HTTP RPC round-trip.

```
CLI (--run)  →  POST /rpc { method: "run", params: { key, cmd } }
                    ↓
             daemon opens DHT connection
                    ↓
             streams command over hypershell
                    ↓
             returns { stdout, stderr }
```

---

## Security

**What is protected:**
- All traffic is end-to-end encrypted via Noise Protocol — no plaintext ever leaves the socket
- The DHT network cannot read your traffic, only relay encrypted packets
- A valid keypair (derived from the seed) is required to open a shell channel

**What is NOT protected by default:**
- The seed is effectively a password. Treat it like one — do not reuse it, do not commit it, do not log it.
- The local RPC daemon binds only to `127.0.0.1` — it is not reachable from the network, but any local process can call it.

**Use a hard seed:**
```
openssl rand -hex 16
# → e3b4f2a1c8d7e6f5a4b3c2d1e0f9a8b7
```

---

## RPC API

The daemon exposes a JSON-RPC interface at `http://127.0.0.1:<port>/rpc`.

| Method | Params | Returns |
|--------|--------|---------|
| `run` | `{ key, cmd }` | `{ stdout, stderr }` |
| `connect` | `{ key }` | `{ id }` |
| `disconnect` | `{ id }` | `{ ok }` |
| `connections` | — | `{ ids }` |
| `shutdown` | — | `{ ok }` |

```js
// Programmatic use
const port = fs.readFileSync(path.join(os.tmpdir(), 'agent-remote.port'), 'utf8').trim()
const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
  method: 'POST',
  body: JSON.stringify({ id: 1, method: 'run', params: { key: 'myseed', cmd: 'whoami' } })
})
const { result } = await res.json()
console.log(result.stdout)
```

---

## CLI

```
# Remote machine — start the shell server
bun x agent-remote --server --key <seed>

# Local machine — start the persistent daemon
bun x agent-remote --daemon

# Run a command (daemon must be running)
bun x agent-remote --run --key <seed> <command>

# Shutdown the daemon
bun x agent-remote --shutdown
```

---

## Stack

| Layer | Package | Role |
|-------|---------|------|
| DHT | `hyperdht` | Peer discovery, NAT traversal, Noise encryption |
| Multiplexing | `protomux` | Logical channels over one socket |
| Shell protocol | `hypershell` | PTY negotiation, stdio framing |
| Key encoding | `hypercore-id-encoding` | Hex encode/decode public keys |
| Local IPC | `node:http` | Atomic RPC between CLI and daemon |
