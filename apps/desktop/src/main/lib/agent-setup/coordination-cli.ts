import fs from "node:fs";
import path from "node:path";
import { BIN_DIR } from "./paths";

const SCRIPT_NAME = "ade-coord.cjs";

function writeFileIfChanged(
	filePath: string,
	content: string,
	mode = 0o755,
): void {
	const existing = fs.existsSync(filePath)
		? fs.readFileSync(filePath, "utf8")
		: null;
	if (existing !== content) fs.writeFileSync(filePath, content, { mode });
	try {
		fs.chmodSync(filePath, mode);
	} catch {
		// Best effort on Windows.
	}
}

export function getCoordinationCliContent(): string {
	return `#!/usr/bin/env node
const port = process.env.SUPERSET_PORT;
const workspaceId = process.env.SUPERSET_WORKSPACE_ID;
const token = process.env.ADE_COORDINATION_TOKEN;

function fail(message) {
  console.error(\`ade-coord: \${message}\`);
  process.exitCode = 1;
}

async function request(route, options = {}) {
  if (!port || !workspaceId || !token) {
    throw new Error("run this command inside an ADE workspace terminal");
  }
  const response = await fetch(\`http://127.0.0.1:\${port}\${route}\`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-ade-token": token,
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || \`request failed (\${response.status})\`);
  return body;
}

function print(value) {
  process.stdout.write(\`\${JSON.stringify(value, null, 2)}\\n\`);
}

function help() {
  console.log(\`Usage:
  ade-coord peers
  ade-coord inbox [--all]
  ade-coord send <workspace-id|all> <message> [--kind=handoff|decision|artifact|message]
  ade-coord ack <message-id>
  ade-coord remember <key> <content> [--workspace]
  ade-coord context [objective]

Messages and memory stay inside the current ADE project.\`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    help();
    return;
  }

  if (command === "peers") {
    const body = await request(\`/coordination/peers?workspaceId=\${encodeURIComponent(workspaceId)}\`);
    print(body.peers);
    return;
  }

  if (command === "inbox") {
    const includeAcknowledged = args.includes("--all");
    const body = await request(\`/coordination/inbox?workspaceId=\${encodeURIComponent(workspaceId)}&includeAcknowledged=\${includeAcknowledged}\`);
    print(body.messages);
    return;
  }

  if (command === "send") {
    const recipient = args.shift();
    const kindArg = args.find((arg) => arg.startsWith("--kind="));
    const kind = kindArg ? kindArg.slice("--kind=".length) : "handoff";
    const content = args.filter((arg) => arg !== kindArg).join(" ").trim();
    if (!recipient || !content) throw new Error("send requires a recipient and message");
    const body = await request("/coordination/message", {
      method: "POST",
      body: JSON.stringify({
        senderWorkspaceId: workspaceId,
        recipientWorkspaceId: recipient === "all" ? null : recipient,
        kind,
        content,
      }),
    });
    print(body.message);
    return;
  }

  if (command === "ack") {
    const messageId = args[0];
    if (!messageId) throw new Error("ack requires a message id");
    const body = await request(\`/coordination/message/\${encodeURIComponent(messageId)}/ack\`, {
      method: "POST",
      body: JSON.stringify({ workspaceId }),
    });
    print(body.message);
    return;
  }

  if (command === "remember") {
    const key = args.shift();
    const workspaceOnly = args.includes("--workspace");
    const content = args.filter((arg) => arg !== "--workspace").join(" ").trim();
    if (!key || !content) throw new Error("remember requires a key and content");
    const body = await request("/coordination/memory", {
      method: "POST",
      body: JSON.stringify({
        workspaceId,
        scope: workspaceOnly ? "workspace" : "project",
        key,
        title: key,
        content,
      }),
    });
    print(body.memory);
    return;
  }

  if (command === "context") {
    const objective = args.join(" ").trim();
    const query = new URLSearchParams({ workspaceId });
    if (objective) query.set("objective", objective);
    const body = await request(\`/coordination/context?\${query}\`);
    process.stdout.write(\`\${body.packet.content}\\n\`);
    return;
  }

  throw new Error(\`unknown command: \${command}\`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
`;
}

export function createCoordinationCli(): void {
	const scriptPath = path.join(BIN_DIR, SCRIPT_NAME);
	writeFileIfChanged(scriptPath, getCoordinationCliContent());
	if (process.platform === "win32") {
		writeFileIfChanged(
			path.join(BIN_DIR, "ade-coord.cmd"),
			`@echo off\r\nnode "%~dp0${SCRIPT_NAME}" %*\r\n`,
		);
	} else {
		writeFileIfChanged(
			path.join(BIN_DIR, "ade-coord"),
			`#!/bin/sh\nexec node "$(dirname "$0")/${SCRIPT_NAME}" "$@"\n`,
		);
	}
}
