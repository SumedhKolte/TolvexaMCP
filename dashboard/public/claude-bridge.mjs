#!/usr/bin/env node
import readline from "node:readline";

const url = process.argv[2] || process.env.MCP_GATEWAY_URL || "http://hub.localtest.me/mcp";
const key = process.argv[3] || process.env.MCP_API_KEY;

if (!key) {
  process.stderr.write("Error: Missing MCP API key. Usage: node claude-bridge.mjs <url> <apiKey>\n");
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: trimmed,
    });
    const text = await res.text();
    for (const chunk of text.split("\n")) {
      const lineText = chunk.trim();
      if (!lineText) continue;
      if (lineText.startsWith("data:")) {
        process.stdout.write(lineText.slice(5).trim() + "\n");
      } else {
        process.stdout.write(lineText + "\n");
      }
    }
  } catch (err) {
    process.stderr.write(`[bridge error] ${err.message}\n`);
  }
});
