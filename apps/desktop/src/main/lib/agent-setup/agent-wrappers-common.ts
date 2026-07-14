import fs from "node:fs";
import path from "node:path";
import {
	type AgentBinary,
	BINARY_INSTALL,
	getBinaryInstallInfo,
} from "@superset/shared/agent-binaries";
import { BIN_DIR } from "./paths";

export const WRAPPER_MARKER = "# ADE agent-wrapper v2";

/**
 * Marker substring present in every agent-wrapper header (ADE's own wrappers and
 * legacy local wrappers both use "... agent-wrapper ..."). find_real_binary
 * skips any candidate whose header contains it, so a wrapper never resolves to
 * another wrapper.
 */
const WRAPPER_HEADER_NEEDLE = "agent-wrapper";

// npm's Windows cmd-shim format. Capturing the JavaScript entry point lets the
// generated wrapper bypass cmd.exe, whose percent expansion and quote parsing
// can mutate Codex's per-workspace developer instructions.
const NODE_CMD_SHIM_TARGET_PATTERN =
	/(?:^|\r?\n)[ \t]*endLocal[ \t]+&[ \t]+goto[ \t]+#_undefined_#[ \t]+2>NUL[ \t]+\|\|[ \t]+title[ \t]+%COMSPEC%[ \t]+&[ \t]+"%_prog%"[ \t]+"%(?:~dp0|dp0%)([\\/]*[^"\r\n]+?\.(?:[cm]?js))"[ \t]+%\*[ \t]*(?:\r?\n)?$/i;
const LEADING_PATH_SEPARATORS_PATTERN = /^[\\/]+/;
const WINDOWS_BATCH_EXTENSION_PATTERN = /\.(?:cmd|bat)$/i;
const NODE_SHEBANG_PATTERN = /^#![^\r\n]*\bnode(?:\.exe)?\b/i;

export function extractNodeCmdShimTarget(source: string): string | null {
	return NODE_CMD_SHIM_TARGET_PATTERN.exec(source)?.[1] ?? null;
}

// Matches ADE-managed hook paths under the app home dir (~/.ade or
// ~/.ade-<workspace>). MUST be ADE's own dir, not another app's home — otherwise
// ADE would treat a legacy install's hooks as its own and clobber them, and
// fail to recognize (so would duplicate) its own hooks in shared agent settings.
const SUPERSET_MANAGED_HOOK_PATH_PATTERN = /\/\.ade(?:-[^/'"\s\\]+)?\//;

export function writeFileIfChanged(
	filePath: string,
	content: string,
	mode: number,
): boolean {
	const existing = fs.existsSync(filePath)
		? fs.readFileSync(filePath, "utf-8")
		: null;
	if (existing === content) {
		try {
			fs.chmodSync(filePath, mode);
		} catch {
			// Best effort.
		}
		return false;
	}

	fs.writeFileSync(filePath, content, { mode });
	return true;
}

export function isSupersetManagedHookCommand(
	command: string | undefined,
	scriptName: string,
): boolean {
	if (!command) return false;
	const normalized = command.replaceAll("\\", "/");
	const baseName = scriptName.replace(/\.(sh|cmd|cjs)$/i, "");
	const scriptNames = [
		scriptName,
		`${baseName}.sh`,
		`${baseName}.cmd`,
		`${baseName}.cjs`,
	];
	if (!scriptNames.some((name) => normalized.includes(`/hooks/${name}`))) {
		return false;
	}
	return SUPERSET_MANAGED_HOOK_PATH_PATTERN.test(normalized);
}

function buildRealBinaryResolver(): string {
	return `find_real_binary() {
  local name="$1"
  local IFS=:
  for dir in $PATH; do
    [ -z "$dir" ] && continue
    dir="\${dir%/}"
    case "$dir" in
      "${BIN_DIR}"|"$HOME"/.ade/bin|"$HOME"/.ade-*/bin) continue ;;
    esac
    local candidate="$dir/$name"
    if [ -x "$candidate" ] && [ ! -d "$candidate" ]; then
      # Skip other agent-wrapper shims (another ADE wrapper on PATH, or a
      # legacy local wrapper) so we resolve the real binary directly. Chaining
      # wrappers ping-pongs and keeps prepending --settings, which breaks the
      # CLI's interactive TUI.
      if head -c 512 "$candidate" 2>/dev/null | grep -qa "${WRAPPER_HEADER_NEEDLE}"; then
        continue
      fi
      printf "%s\\n" "$candidate"
      return 0
    fi
  done
  return 1
}
`;
}

function getMissingBinaryMessage(name: string): string {
	// Enrich with the per-tool install command + URL so the terminal fallback is
	// self-explanatory. Embedded inside a bash double-quoted echo, so the message
	// must stay on one line and avoid double quotes / $ / backticks (install
	// commands and URLs contain none).
	const info =
		name in BINARY_INSTALL ? getBinaryInstallInfo(name as AgentBinary) : null;
	if (info) {
		return `ADE: ${name} not found on PATH. Install ${info.label}: ${info.command} — ${info.url}`;
	}
	return `ADE: ${name} not found in PATH. Install it and ensure it is on PATH, then retry.`;
}

export function getWrapperPath(binaryName: string): string {
	return path.join(BIN_DIR, binaryName);
}

export function buildWrapperScript(
	binaryName: string,
	execLine: string,
): string {
	return `#!/bin/bash
${WRAPPER_MARKER}
# ADE wrapper for ${binaryName}

${buildRealBinaryResolver()}
REAL_BIN="$(find_real_binary "${binaryName}")"
if [ -z "$REAL_BIN" ]; then
  echo "${getMissingBinaryMessage(binaryName)}" >&2
  exit 127
fi

${execLine}
`;
}

interface WindowsWrapperOptions {
	argsPrefix?: string[];
	env?: Record<string, string>;
	prelude?: string;
	requireExactArgs?: boolean;
}

function buildCmdLauncher(binaryName: string): string {
	return `@echo off\r\nnode "%~dp0${binaryName}.cjs" %*\r\n`;
}

export function buildWindowsWrapperScript(
	binaryName: string,
	options: WindowsWrapperOptions = {},
): string {
	const argsPrefix = JSON.stringify(options.argsPrefix ?? []);
	const extraEnv = JSON.stringify(options.env ?? {});
	const missingMessage = JSON.stringify(getMissingBinaryMessage(binaryName));
	const prelude = options.prelude ?? "";
	const requireExactArgs = options.requireExactArgs ?? false;

	return `#!/usr/bin/env node
// ${WRAPPER_MARKER}
// ADE Windows wrapper for ${binaryName}

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const binaryName = ${JSON.stringify(binaryName)};
const binDir = __dirname;
const argsPrefix = ${argsPrefix};
const extraEnv = ${extraEnv};
const missingMessage = ${missingMessage};
const wrapperHeaderNeedle = ${JSON.stringify(WRAPPER_HEADER_NEEDLE)};
const requireExactArgs = ${JSON.stringify(requireExactArgs)};
const nodeCmdShimTargetPattern = ${NODE_CMD_SHIM_TARGET_PATTERN.toString()};
const leadingPathSeparatorsPattern = ${LEADING_PATH_SEPARATORS_PATTERN.toString()};
const windowsBatchExtensionPattern = ${WINDOWS_BATCH_EXTENSION_PATTERN.toString()};
const nodeShebangPattern = ${NODE_SHEBANG_PATTERN.toString()};

function normalizePath(value) {
  try {
    return fs.realpathSync.native(value).toLowerCase();
  } catch {
    return path.resolve(value).toLowerCase();
  }
}

function isManagedBinDir(dir) {
  const normalized = normalizePath(dir).replaceAll("\\\\", "/");
  if (normalized === normalizePath(binDir).replaceAll("\\\\", "/")) return true;
  return /\\/\\.ade(?:-[^/]+)?\\/bin$/i.test(normalized);
}

function candidatePaths(dir, name) {
  const extensions = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  const hasExtension = Boolean(path.extname(name));
  // Windows cannot execute npm's extensionless POSIX shim. Resolve PATHEXT
  // launchers first so the native .exe or npm .cmd is selected instead.
  const names = hasExtension ? [name] : extensions.map((ext) => \`\${name}\${ext.toLowerCase()}\`);
  return [...new Set(names)].map((candidate) => path.join(dir, candidate));
}

function hasWrapperMarker(candidate) {
  try {
    const header = fs.readFileSync(candidate, { encoding: "utf8", flag: "r" }).slice(0, 512);
    return header.includes(wrapperHeaderNeedle);
  } catch {
    return false;
  }
}

function getNodeCmdShimEntrypoint(candidate) {
  if (!windowsBatchExtensionPattern.test(candidate)) return null;
  try {
    const source = fs.readFileSync(candidate, "utf8");
    const match = nodeCmdShimTargetPattern.exec(source);
    if (!match) return null;
    const relativeScript = match[1].replace(leadingPathSeparatorsPattern, "");
    const entrypoint = path.resolve(path.dirname(candidate), relativeScript);
    const stat = fs.statSync(entrypoint);
    if (!stat.isFile()) return null;
    const header = fs.readFileSync(entrypoint, "utf8").slice(0, 256);
    return nodeShebangPattern.test(header) ? entrypoint : null;
  } catch {
    return null;
  }
}

function findRealBinary(name) {
  const pathValue = process.env.Path || process.env.PATH || "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir || isManagedBinDir(dir)) continue;
    for (const candidate of candidatePaths(dir, name)) {
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile() || hasWrapperMarker(candidate)) continue;
        if (
          requireExactArgs &&
          windowsBatchExtensionPattern.test(candidate) &&
          !getNodeCmdShimEntrypoint(candidate)
        ) {
          // Keep walking PATH for a native executable. Passing exact arguments
          // through an unknown batch file would re-enable cmd.exe expansion.
          continue;
        }
        return candidate;
      } catch {
        // Continue searching.
      }
    }
  }
  return null;
}

const realBin = findRealBinary(binaryName);
if (!realBin) {
  console.error(
    requireExactArgs
      ? "ADE: " + binaryName + " has no safe Windows launcher on PATH. Install its official npm shim or native executable, then retry."
      : missingMessage,
  );
  process.exit(127);
}

const env = { ...process.env, ...extraEnv };
const args = [...argsPrefix, ...process.argv.slice(2)];
${prelude}
const shimEntrypoint = getNodeCmdShimEntrypoint(realBin);
const localNode = path.join(path.dirname(realBin), "node.exe");
const launchCommand = shimEntrypoint
  ? (fs.existsSync(localNode) ? localNode : process.execPath)
  : realBin;
const launchArgs = shimEntrypoint ? [shimEntrypoint, ...args] : args;
const child = spawn(launchCommand, launchArgs, {
  stdio: "inherit",
  env,
  shell: !shimEntrypoint && windowsBatchExtensionPattern.test(realBin),
});

child.on("error", (error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
`;
}

export function createWrapper(
	binaryName: string,
	script: string,
	windowsScript = buildWindowsWrapperScript(binaryName),
): void {
	const changed = writeFileIfChanged(getWrapperPath(binaryName), script, 0o755);
	if (process.platform === "win32") {
		writeFileIfChanged(
			path.join(BIN_DIR, `${binaryName}.cjs`),
			windowsScript,
			0o755,
		);
		writeFileIfChanged(
			path.join(BIN_DIR, `${binaryName}.cmd`),
			buildCmdLauncher(binaryName),
			0o755,
		);
	}
	console.log(
		`[agent-setup] ${changed ? "Updated" : "Verified"} ${binaryName} wrapper`,
	);
}
