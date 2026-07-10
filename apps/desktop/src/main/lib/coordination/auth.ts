import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	ensureSupersetHomeDirExists,
	getSupersetHomeDir,
	SUPERSET_SENSITIVE_FILE_MODE,
} from "../app-environment";

const TOKEN_FILE_NAME = "coordination-token";
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
let cachedToken: string | null = null;

function constantTimeEqual(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return (
		leftBuffer.length === rightBuffer.length &&
		timingSafeEqual(leftBuffer, rightBuffer)
	);
}

export function getCoordinationTokenPath(): string {
	return join(getSupersetHomeDir(), TOKEN_FILE_NAME);
}

/**
 * Internal coordinator secret. It is stored outside repositories with owner-only
 * permissions and is never injected into agent terminals.
 */
export function getInternalCoordinationToken(): string {
	if (cachedToken) return cachedToken;
	ensureSupersetHomeDirExists();
	const tokenPath = getCoordinationTokenPath();

	try {
		const existing = readFileSync(tokenPath, "utf8").trim();
		if (TOKEN_PATTERN.test(existing)) {
			cachedToken = existing;
			try {
				chmodSync(tokenPath, SUPERSET_SENSITIVE_FILE_MODE);
			} catch {
				// Best effort on filesystems without POSIX permissions.
			}
			return existing;
		}
	} catch {
		// Create a fresh token below.
	}

	const token = randomBytes(32).toString("hex");
	writeFileSync(tokenPath, `${token}\n`, {
		encoding: "utf8",
		mode: SUPERSET_SENSITIVE_FILE_MODE,
	});
	cachedToken = token;
	return token;
}

/**
 * A workspace capability proves that a request came from an ADE terminal
 * without exposing the internal token. It cannot be used for privileged
 * endpoints such as autonomous agent invocation.
 */
export function getWorkspaceCoordinationToken(workspaceId: string): string {
	return createHmac("sha256", getInternalCoordinationToken())
		.update(`workspace:${workspaceId}`)
		.digest("hex");
}

export function isValidInternalCoordinationToken(
	provided: string | undefined,
): boolean {
	return (
		!!provided && constantTimeEqual(provided, getInternalCoordinationToken())
	);
}

export function isValidWorkspaceCoordinationToken(
	workspaceId: string,
	provided: string | undefined,
): boolean {
	if (!workspaceId || !provided) return false;
	return constantTimeEqual(
		provided,
		getWorkspaceCoordinationToken(workspaceId),
	);
}

export function resetCoordinationAuthForTests(): void {
	cachedToken = null;
}
