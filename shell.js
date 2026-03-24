#!/usr/bin/env node
import { createHash } from "node:crypto";
import http from "node:http";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PORT_FILE = join(tmpdir(), "agent-shell.port");

// ── key derivation ────────────────────────────────────────────────────────────

async function deriveKeyPair(keyString) {
  const DHT = (await import("hyperdht")).default;
  const seed = createHash("sha256").update(keyString).digest();
  return { keyPair: DHT.keyPair(seed), DHT };
}

// ── server mode ───────────────────────────────────────────────────────────────

async function runServer(keyString) {
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
    mux.pair({ protocol: "hypershell" }, () => {
      const shell = new ShellServer({ node, socket, mux });
      if (shell.channel) shell.open();
    });
  });

  await server.listen(keyPair);
  const pubHex = HypercoreId.encode(keyPair.publicKey);
  console.log("Shell server listening");
  console.log("Key seed: " + keyString);
  console.log("Public key: " + pubHex);
  console.log("Connect with: agent-shell --client --key " + keyString);
}

// ── shell detection ───────────────────────────────────────────────────────────

const SHELL = process.platform === "win32"
  ? { bin: process.env.COMSPEC || "cmd.exe", flag: "/c" }
  : { bin: process.env.SHELL || "/bin/sh", flag: "-c" };

// ── daemon: persistent DHT node + connection pool ────────────────────────────

let _dht = null;
const _connections = new Map(); // id → { socket, mux, client }
let _nextId = 1;

async function getDHT(keyString) {
  if (_dht) return _dht;
  const { DHT } = await deriveKeyPair(keyString);
  _dht = { node: new DHT(), keyString };
  return _dht;
}

async function connectTo(keyString) {
  const Protomux = (await import("protomux")).default;
  const { ShellClient } = await import("hypershell/lib/shell.js");
  const { keyPair, DHT } = await deriveKeyPair(keyString);

  const node = new DHT();
  const socket = node.connect(keyPair.publicKey, { keyPair });

  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  socket.on("end", () => socket.end());
  socket.once("close", () => node.destroy());
  socket.setKeepAlive(5000);

  const id = _nextId++;
  _connections.set(id, { socket, node });
  return id;
}

async function runCommand(keyString, cmd) {
  const Protomux = (await import("protomux")).default;
  const { ShellClient } = await import("hypershell/lib/shell.js");
  const { keyPair, DHT } = await deriveKeyPair(keyString);

  const node = new DHT();
  const socket = node.connect(keyPair.publicKey, { keyPair });

  let stdout = "";
  let stderr = "";

  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  socket.setKeepAlive(5000);

  return new Promise((resolve, reject) => {
    const mux = new Protomux(socket);
    const args = Array.isArray(cmd) ? ["--", ...cmd] : ["--", SHELL.bin, SHELL.flag, cmd];
    const client = new ShellClient(args, { socket, mux });

    if (!client.channel) {
      socket.destroy();
      node.destroy();
      return reject(new Error("ShellClient channel not opened"));
    }

    const origWrite = process.stdout.write.bind(process.stdout);
    const origErrWrite = process.stderr.write.bind(process.stderr);

    client.channel.messages[1]?.on("data", buf => { stdout += buf.toString(); });
    client.channel.messages[2]?.on("data", buf => { stderr += buf.toString(); });

    client.channel.on("close", () => {
      socket.destroy();
      node.destroy();
      resolve({ stdout, stderr });
    });

    client.open();
  });
}

// ── HTTP RPC daemon ───────────────────────────────────────────────────────────

function sendJSON(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

async function handleRPC(body) {
  const { method, params = {} } = body;
  switch (method) {
    case "run": {
      const { key, cmd } = params;
      if (!key || !cmd) throw new Error("run requires key and cmd");
      const result = await runCommand(key, cmd);
      return result;
    }
    case "connect": {
      const { key } = params;
      if (!key) throw new Error("connect requires key");
      const id = await connectTo(key);
      return { id };
    }
    case "disconnect": {
      const { id } = params;
      const conn = _connections.get(id);
      if (!conn) return { ok: false };
      conn.socket.destroy();
      conn.node.destroy();
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

async function startDaemon() {
  const server = http.createServer(handleRequest);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  writeFileSync(PORT_FILE, String(port));
  console.log("agent-shell daemon listening on port " + port);
  console.log("Port file: " + PORT_FILE);

  process.on("SIGTERM", () => { try { unlinkSync(PORT_FILE); } catch {} process.exit(0); });
  process.on("SIGINT", () => { try { unlinkSync(PORT_FILE); } catch {} process.exit(0); });
}

// ── CLI client ────────────────────────────────────────────────────────────────

async function rpc(method, params) {
  const port = parseInt(readFileSync(PORT_FILE, "utf8").trim(), 10);
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ id: 1, method, params });
    const req = http.request({ hostname: "127.0.0.1", port, path: "/rpc", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try {
          const r = JSON.parse(Buffer.concat(chunks).toString());
          if (r.error) reject(new Error(r.error.message));
          else resolve(r.result);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const keyIdx = args.indexOf("--key");
  const keyString = keyIdx !== -1 ? args[keyIdx + 1] : "agent-shell-default";

  if (args.includes("--server")) {
    await runServer(keyString);
    return;
  }

  if (args.includes("--daemon")) {
    await startDaemon();
    return;
  }

  if (args.includes("--run")) {
    const runIdx = args.indexOf("--run");
    const cmd = args.slice(runIdx + 1).filter(a => a !== "--key" && a !== keyString).join(" ");
    const result = await rpc("run", { key: keyString, cmd });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return;
  }

  if (args.includes("--shutdown")) {
    await rpc("shutdown", {});
    console.log("Daemon shutting down.");
    return;
  }

  console.log(`Usage:
  --server --key <seed>           Start hypershell server (listens for connections)
  --daemon                        Start local RPC daemon (keeps DHT node alive)
  --run --key <seed> <cmd...>     Run a command via the daemon
  --shutdown                      Stop the daemon`);
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
