#!/usr/bin/env node
import { createHash } from "node:crypto";
import http from "node:http";
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const PORT_FILE = join(tmpdir(), "agent-remote.port");
const SHELL = process.platform === "win32"
    ? { bin: process.env.COMSPEC || "cmd.exe", flag: "/c" }
    : { bin: process.env.SHELL || "/bin/sh", flag: "-c" };

export async function deriveKeyPair(keyString) {
    const DHT = (await import("hyperdht")).default;
    const seed = createHash("sha256").update(String(keyString)).digest();
    return { keyPair: DHT.keyPair(seed), DHT, seed };
}

export async function runServer(keyString) {
    const HypercoreId = (await import("hypercore-id-encoding")).default;
    const Protomux = (await import("protomux")).default;
    const { ShellServer } = await import("hypershell/lib/shell.js");
    const { keyPair, DHT } = await deriveKeyPair(keyString);
    const node = new DHT();
    const server = node.createServer({ firewall: () => false });
    server.on("connection", socket => {
        socket.on("end", () => socket.end());
        socket.on("error", err => {
            if (err.code !== "ECONNRESET" && err.code !== "ETIMEDOUT") console.error(err);
        });
        socket.setKeepAlive(5000);
        const mux = new Protomux(socket);
        const shell = new ShellServer({ mux });
        if (shell.channel) shell.open();
    });
    await server.listen(keyPair);
    const pubHex = HypercoreId.encode(keyPair.publicKey);
    console.log("agent-remote server listening");
    console.log("Seed: " + keyString);
    console.log("Public key: " + pubHex);
    console.log("Clients connect with: npx agent-remote --run --key " + keyString + " <command>");
    return { node, server, keyPair, publicKey: pubHex };
}

const _connections = new Map();
let _nextId = 1;
let _dht = null;

async function getDHT() {
    if (_dht) return _dht;
    const { DHT } = await deriveKeyPair("__bootstrap__");
    _dht = new DHT();
    return _dht;
}

export async function connectTo(keyString) {
    const { keyPair } = await deriveKeyPair(keyString);
    const node = await getDHT();
    const socket = node.connect(keyPair.publicKey, { keyPair });
    await new Promise((res, rej) => { socket.once("open", res); socket.once("error", rej); });
    socket.setKeepAlive(5000);
    const id = _nextId++;
    _connections.set(id, { socket });
    socket.once("close", () => _connections.delete(id));
    return id;
}

export async function runCommand(keyString, cmd) {
    const Protomux = (await import("protomux")).default;
    const { handshakeSpawn, resize } = await import("hypershell/messages.js");
    const { buffer, uint } = await import("compact-encoding");
    const { keyPair, DHT } = await deriveKeyPair(keyString);
    const node = new DHT();
    const socket = node.connect(keyPair.publicKey, { keyPair });
    await new Promise((res, rej) => { socket.once("open", res); socket.once("error", rej); });
    socket.setKeepAlive(5000);
    const cmdString = Array.isArray(cmd) ? cmd.join(" ") : cmd;
    const tag = Math.random().toString(36).slice(2);
    const START = "__AGENT_REMOTE_BEGIN_" + tag + "__";
    const END = "__AGENT_REMOTE_END_" + tag + "__";
    return new Promise((resolveP, reject) => {
        let stdout = "";
        let stderr = "";
        let exitCode = null;
        const mux = new Protomux(socket);
        const channel = mux.createChannel({
            protocol: "hypershell",
            id: null,
            handshake: handshakeSpawn,
            onopen() {
                const script = `${cmdString}\r\necho ${START}$LASTEXITCODE${END}\r\nexit\r\n`;
                channel.messages[0].send(Buffer.from(script));
            },
            onclose() {
                const stripAnsi = s => s
                    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
                    .replace(/\x1b\[[\d;?]*[a-zA-Z]/g, "")
                    .replace(/\x1b[=>()][^\s]?/g, "");
                const clean = stripAnsi(stdout).replace(/\r/g, "");
                const re = new RegExp(START + "(\\d*)" + END);
                const m = clean.match(re);
                let body = clean;
                if (m) {
                    if (m[1] !== "") exitCode = parseInt(m[1], 10);
                    body = clean.slice(0, m.index);
                }
                socket.destroy(); node.destroy();
                resolveP({ stdout: body, stderr, exitCode });
            },
            messages: [
                { encoding: buffer },
                { encoding: buffer, onmessage(buf) { stdout += buf.toString(); } },
                { encoding: buffer, onmessage(buf) { stderr += buf.toString(); } },
                { encoding: uint, onmessage(c) { exitCode = c; } },
                { encoding: resize },
            ]
        });
        if (!channel) {
            socket.destroy();
            node.destroy();
            return reject(new Error("Could not open shell channel"));
        }
        channel.open({ width: 200, height: 50 });
    });
}

function sendJSON(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
    res.end(data);
}

async function readBody(req) {
    return new Promise((res, rej) => {
        const chunks = [];
        req.on("data", c => chunks.push(c));
        req.on("end", () => { try { res(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { rej(e); } });
        req.on("error", rej);
    });
}

async function handleRPC(body) {
    const { method, params = {} } = body;
    switch (method) {
        case "run": {
            const { key, cmd } = params;
            if (!key || !cmd) throw new Error("run requires key and cmd");
            return await runCommand(key, cmd);
        }
        case "connect": {
            const { key } = params;
            if (!key) throw new Error("connect requires key");
            return { id: await connectTo(key) };
        }
        case "disconnect": {
            const { id } = params;
            const conn = _connections.get(id);
            if (!conn) return { ok: false };
            conn.socket.destroy();
            _connections.delete(id);
            return { ok: true };
        }
        case "connections":
            return { ids: [..._connections.keys()] };
        case "shutdown":
            setImmediate(() => process.exit(0));
            return { ok: true };
        default:
            throw Object.assign(new Error("Unknown method: " + method), { code: -32601 });
    }
}

async function handleRequest(req, res) {
    try {
        if (req.method === "GET" && req.url === "/health") return sendJSON(res, 200, { ok: true });
        if (req.method === "POST" && req.url === "/rpc") {
            const body = await readBody(req);
            try { return sendJSON(res, 200, { id: body.id, result: await handleRPC(body) }); }
            catch (e) { return sendJSON(res, 200, { id: body.id, error: { code: e.code || -32603, message: e.message } }); }
        }
        sendJSON(res, 404, { error: "Not found" });
    } catch (e) { try { sendJSON(res, 400, { error: e.message }); } catch (_) {} }
}

async function checkPortAlive(port) {
    return new Promise(res => {
        const req = http.request(
            { hostname: "127.0.0.1", port, path: "/health", method: "GET", timeout: 1000 },
            r => { r.resume(); res(true); }
        );
        req.on("error", () => res(false));
        req.on("timeout", () => { req.destroy(); res(false); });
        req.end();
    });
}

export async function startDaemon() {
    if (existsSync(PORT_FILE)) {
        const existingPort = parseInt(readFileSync(PORT_FILE, "utf8").trim(), 10);
        if (await checkPortAlive(existingPort)) {
            console.error("Daemon already running on port " + existingPort);
            process.exit(1);
        }
        unlinkSync(PORT_FILE);
    }
    const server = http.createServer(handleRequest);
    await new Promise((res, rej) => {
        server.once("error", rej);
        server.listen(0, "127.0.0.1", res);
    });
    const port = server.address().port;
    writeFileSync(PORT_FILE, String(port));
    console.log("agent-remote daemon listening on port " + port);
    console.log("Port file: " + PORT_FILE);
    process.on("SIGTERM", () => { try { unlinkSync(PORT_FILE); } catch {} process.exit(0); });
    process.on("SIGINT", () => { try { unlinkSync(PORT_FILE); } catch {} process.exit(0); });
    return { server, port };
}

export async function rpc(method, params) {
    const port = parseInt(readFileSync(PORT_FILE, "utf8").trim(), 10);
    return new Promise((res, rej) => {
        const body = JSON.stringify({ id: 1, method, params });
        const req = http.request({ hostname: "127.0.0.1", port, path: "/rpc", method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
        }, resp => {
            const chunks = [];
            resp.on("data", c => chunks.push(c));
            resp.on("end", () => {
                try {
                    const r = JSON.parse(Buffer.concat(chunks).toString());
                    if (r.error) rej(new Error(r.error.message));
                    else res(r.result);
                } catch (e) { rej(e); }
            });
        });
        req.on("error", rej);
        req.end(body);
    });
}

const SKILL_MD = `---
name: agent-remote
description: Open a peer-to-peer remote shell to any machine over HyperDHT using a shared seed. No ports, no firewall, no servers. Use when you need to run commands on a remote host, deploy code, or debug a system that the user is sitting in front of elsewhere. Run via "npx agent-remote" or "bunx agent-remote" — works anywhere Node or Bun is installed.
---

# agent-remote

Peer-to-peer remote shell over HyperDHT. Both sides derive the same Curve25519 keypair from a shared seed string; the public key is the address on the DHT.

## How to use

You (the agent) run the client. The user runs the server on the remote machine. Pick a strong shared seed (e.g. \`openssl rand -hex 16\`) and tell the user the exact command to paste on the remote side.

### 1. Tell the user to run this on the REMOTE machine

\`\`\`
npx agent-remote --server --key <SEED>
\`\`\`

Or with Bun: \`bunx agent-remote --server --key <SEED>\`

The server prints "agent-remote server listening" once it is on the DHT.

### 2. On YOUR side, start the local daemon (once per session)

\`\`\`
npx agent-remote --daemon &
\`\`\`

### 3. Run commands

\`\`\`
npx agent-remote --run --key <SEED> <command...>
\`\`\`

Example: \`npx agent-remote --run --key my-shared-seed-abc123 whoami\`

stdout/stderr stream back; the remote exit code becomes the local exit code.

### 4. Stop the daemon

\`\`\`
npx agent-remote --shutdown
\`\`\`

## Notes for the agent

- The seed is the password. Generate a fresh one per session; never reuse, never log, never commit.
- \`npx agent-remote\` and \`bunx agent-remote\` are equivalent — pick whichever is on the user's PATH.
- For NAT-heavy networks the first connection may take a few seconds while DHT bootstraps.
- SDK use: \`import { runCommand, runServer, deriveKeyPair } from "agent-remote"\`.
`;

function installSkill(targetDir) {
    const skillDir = join(resolve(targetDir), ".claude", "skills", "agent-remote");
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    writeFileSync(skillPath, SKILL_MD);
    console.log("Installed agent-remote skill to: " + skillPath);
    return skillPath;
}

async function main() {
    const args = process.argv.slice(2);
    const keyIdx = args.indexOf("--key");
    const keyString = keyIdx !== -1 ? args[keyIdx + 1] : "agent-remote-default";

    if (args.includes("--install-skill")) {
        const i = args.indexOf("--install-skill");
        const target = args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : process.cwd();
        return installSkill(target);
    }
    if (args.includes("--server")) return runServer(keyString);
    if (args.includes("--daemon")) return startDaemon();

    if (args.includes("--run")) {
        const runIdx = args.indexOf("--run");
        const after = args.slice(runIdx + 1);
        const kIdx = after.indexOf("--key");
        if (kIdx !== -1) after.splice(kIdx, 2);
        const cmd = after.join(" ");
        const result = await rpc("run", { key: keyString, cmd });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        if (typeof result.exitCode === "number") process.exitCode = result.exitCode;
        return;
    }

    if (args.includes("--shutdown")) {
        await rpc("shutdown", {});
        console.log("Daemon shutting down.");
        return;
    }

    if (args.includes("--pubkey")) {
        const HypercoreId = (await import("hypercore-id-encoding")).default;
        const { keyPair } = await deriveKeyPair(keyString);
        console.log(HypercoreId.encode(keyPair.publicKey));
        return;
    }

    console.log(`agent-remote — peer-to-peer remote shell over HyperDHT

Usage:
  npx agent-remote --server --key <seed>         Run on the REMOTE machine (listens on DHT)
  npx agent-remote --daemon                      Start local RPC daemon (LOCAL side)
  npx agent-remote --run --key <seed> <cmd...>   Run a command on the remote (LOCAL side)
  npx agent-remote --shutdown                    Stop the local daemon
  npx agent-remote --pubkey --key <seed>         Print derived public key (verify seed)
  npx agent-remote --install-skill <dir>         Install Claude Code skill into <dir>/.claude/skills/

Both sides must use the SAME --key seed. Treat the seed as a password.
SDK use: import { runCommand, runServer, deriveKeyPair } from "agent-remote"`);
}

const isMain = (() => {
    try { return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
    catch { return false; }
})();

if (isMain) {
    main().catch(err => {
        console.error("Fatal:", err.message);
        process.exit(1);
    });
}
