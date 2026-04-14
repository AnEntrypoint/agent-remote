#!/usr/bin/env node
// Shell server for remote inspection of machines before/after debloat
import { createHash } from "node:crypto";

process.on("uncaughtException", err => console.error("Uncaught:", err.message));

async function deriveKeyPair(keyString) {
  const DHT = (await import("hyperdht")).default;
  const seed = createHash("sha256").update(keyString).digest();
  return { keyPair: DHT.keyPair(seed), DHT };
}

async function runServer(keyString) {
  const HypercoreId = (await import("hypercore-id-encoding")).default;
  const Protomux = (await import("protomux")).default;
  const { ShellServer } = await import("hypershell/lib/shell.js");
  const { keyPair, DHT } = await deriveKeyPair(keyString);

  const node = new DHT();
  const server = node.createServer({ firewall: () => false });

  server.on("connection", socket => {
    console.log("Client connected");
    socket.on("end", () => socket.end());
    socket.on("error", err => {
      if (err.code !== "ECONNRESET" && err.code !== "ETIMEDOUT") console.error("Socket error:", err.message);
    });
    socket.on("close", () => console.log("Client disconnected"));
    socket.setKeepAlive(5000);
    const mux = new Protomux(socket);
    const shell = new ShellServer({ mux });
    if (shell.channel) shell.open();
  });

  await server.listen(keyPair);
  const pubHex = HypercoreId.encode(keyPair.publicKey);
  console.log("Shell server listening");
  console.log("Key: " + keyString);
  console.log("Public key: " + pubHex);
}

const args = process.argv.slice(2);
const keyIdx = args.indexOf("--key");
const keyString = keyIdx !== -1 ? args[keyIdx + 1] : "debloat-shell";

runServer(keyString).catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
