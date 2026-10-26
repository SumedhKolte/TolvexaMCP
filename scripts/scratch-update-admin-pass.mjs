import argon2 from "../gateway/node_modules/argon2/index.js";
import fs from "fs";
import { spawn } from "child_process";

const env = fs.readFileSync(".env", "utf8");
const passMatch = env.match(/^ADMIN_PASSWORD=(.*)$/m);
const emailMatch = env.match(/^ADMIN_EMAIL=(.*)$/m);

if (!passMatch || !emailMatch) {
  console.error("Missing ADMIN_PASSWORD or ADMIN_EMAIL in .env");
  process.exit(1);
}

const pass = passMatch[1].trim();
const email = emailMatch[1].trim().toLowerCase();

const hash = await argon2.hash(pass, { type: argon2.argon2id });
console.log("Computed hash for email:", email);

const ps = spawn("kubectl", ["-n", "platform", "exec", "-i", "deploy/postgres", "--", "psql", "-U", "gateway", "-d", "gateway"], {
  stdio: ["pipe", "inherit", "inherit"]
});

const sql = `UPDATE users SET password_hash = '${hash.replace(/'/g, "''")}' WHERE email = '${email.replace(/'/g, "''")}';\nDELETE FROM login_failures;\n`;
ps.stdin.write(sql);
ps.stdin.end();

ps.on("close", (code) => {
  console.log("Exited with code", code);
});
