import { beforeEach, describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import {
	createFrameHeader,
	PtySubprocessFrameDecoder,
	PtySubprocessIpcType,
} from "./pty-subprocess-ipc";
import "./xterm-env-polyfill";

const { Session } = await import("./session");

class FakeStdout extends EventEmitter {}

class FakeStdin extends EventEmitter {
	readonly writes: Buffer[] = [];
	readonly writeResults: boolean[] = [];

	write(chunk: Buffer | string): boolean {
		this.writes.push(
			Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"),
		);
		return this.writeResults.shift() ?? true;
	}
}

class FakeChildProcess extends EventEmitter {
	readonly stdout = new FakeStdout();
	readonly stdin = new FakeStdin();
	pid = 4242;
	kill(): boolean {
		return true;
	}
}

let fakeChildProcess: FakeChildProcess;
let spawnCalls: Array<{ command: string; args: string[] }> = [];

describe("Terminal Host Session shell args", () => {
	beforeEach(() => {
		fakeChildProcess = new FakeChildProcess();
		spawnCalls = [];
	});

	it("sends bash --rcfile args in spawn payload", () => {
		const session = new Session({
			sessionId: "session-bash-args",
			workspaceId: "workspace-1",
			paneId: "pane-1",
			tabId: "tab-1",
			cols: 80,
			rows: 24,
			cwd: "/tmp",
			shell: "/bin/bash",
			spawnProcess: (command: string, args: readonly string[], _options) => {
				spawnCalls.push({ command, args: [...args] });
				return fakeChildProcess as unknown as ChildProcess;
			},
		});

		session.spawn({
			cwd: "/tmp",
			cols: 80,
			rows: 24,
			env: { PATH: "/usr/bin" },
		});

		expect(spawnCalls.length).toBe(1);

		fakeChildProcess.stdout.emit(
			"data",
			createFrameHeader(PtySubprocessIpcType.Ready, 0),
		);

		const decoder = new PtySubprocessFrameDecoder();
		const frames = fakeChildProcess.stdin.writes.flatMap((chunk) =>
			decoder.push(chunk),
		);
		const spawnFrame = frames.find(
			(frame) => frame.type === PtySubprocessIpcType.Spawn,
		);

		expect(spawnFrame).toBeDefined();
		const spawnPayload = JSON.parse(
			spawnFrame?.payload.toString("utf8") ?? "{}",
		) as { args?: string[] };

		expect(spawnPayload?.args?.[0]).toBe("--rcfile");
		expect(spawnPayload?.args?.[1]?.endsWith(path.join("bash", "rcfile"))).toBe(
			true,
		);
	});

	it("passes an exact server-derived SSH executable and argv", () => {
		const launch = {
			kind: "ssh" as const,
			executable: "/usr/bin/ssh",
			args: ["-F", "none", "--", "chi@example.com"],
			fingerprint: "fingerprint-one",
			env: { HOME: "/Users/chi", TERM: "xterm-256color" },
		};
		const session = new Session({
			sessionId: "session-ssh-args",
			workspaceId: "workspace-1",
			paneId: "pane-1",
			tabId: "tab-1",
			cols: 80,
			rows: 24,
			cwd: "/tmp",
			launch,
			spawnProcess: (command: string, args: readonly string[], _options) => {
				spawnCalls.push({ command, args: [...args] });
				return fakeChildProcess as unknown as ChildProcess;
			},
		});

		session.spawn({
			cwd: "/tmp",
			cols: 80,
			rows: 24,
			env: launch.env,
		});
		fakeChildProcess.stdout.emit(
			"data",
			createFrameHeader(PtySubprocessIpcType.Ready, 0),
		);

		const decoder = new PtySubprocessFrameDecoder();
		const frames = fakeChildProcess.stdin.writes.flatMap((chunk) =>
			decoder.push(chunk),
		);
		const payload = JSON.parse(
			frames
				.find((frame) => frame.type === PtySubprocessIpcType.Spawn)
				?.payload.toString("utf8") ?? "{}",
		) as { shell?: string; args?: string[] };

		expect(payload.shell).toBe("/usr/bin/ssh");
		expect(payload.args).toEqual(launch.args);
		expect(session.isCompatibleLaunch(launch)).toBe(true);
		expect(
			session.isCompatibleLaunch({ ...launch, fingerprint: "changed" }),
		).toBe(false);
		expect(session.getMeta().transportKind).toBe("ssh");
	});

	it("does not resend an accepted frame after Windows pipe backpressure", () => {
		const session = new Session({
			sessionId: "session-backpressure",
			workspaceId: "workspace-1",
			paneId: "pane-1",
			tabId: "tab-1",
			cols: 80,
			rows: 24,
			cwd: "/tmp",
			shell: "/bin/bash",
			spawnProcess: () => fakeChildProcess as unknown as ChildProcess,
		});

		session.spawn({
			cwd: "/tmp",
			cols: 80,
			rows: 24,
			env: { PATH: "/usr/bin" },
		});

		// Node streams accept the chunk even when write() returns false.
		fakeChildProcess.stdin.writeResults.push(false);
		fakeChildProcess.stdout.emit(
			"data",
			createFrameHeader(PtySubprocessIpcType.Ready, 0),
		);

		expect(fakeChildProcess.stdin.writes).toHaveLength(1);
		fakeChildProcess.stdin.emit("drain");
		expect(fakeChildProcess.stdin.writes).toHaveLength(1);

		const decoder = new PtySubprocessFrameDecoder();
		const frames = decoder.push(fakeChildProcess.stdin.writes[0]);
		expect(frames).toHaveLength(1);
		expect(frames[0]?.type).toBe(PtySubprocessIpcType.Spawn);
	});

	it("queues new frames until the backpressured Windows pipe drains", () => {
		const session = new Session({
			sessionId: "session-backpressure-queue",
			workspaceId: "workspace-1",
			paneId: "pane-1",
			tabId: "tab-1",
			cols: 80,
			rows: 24,
			cwd: "/tmp",
			shell: "/bin/bash",
			spawnProcess: () => fakeChildProcess as unknown as ChildProcess,
		});

		session.spawn({
			cwd: "/tmp",
			cols: 80,
			rows: 24,
			env: { PATH: "/usr/bin" },
		});

		fakeChildProcess.stdin.writeResults.push(false);
		fakeChildProcess.stdout.emit(
			"data",
			createFrameHeader(PtySubprocessIpcType.Ready, 0),
		);
		session.write("queued input");

		// The stream has already accepted the spawn frame. New input must stay in
		// ADE's bounded queue until the stream announces capacity again.
		expect(fakeChildProcess.stdin.writes).toHaveLength(1);

		fakeChildProcess.stdin.emit("drain");
		expect(fakeChildProcess.stdin.writes).toHaveLength(2);

		const decoder = new PtySubprocessFrameDecoder();
		const frames = fakeChildProcess.stdin.writes.flatMap((chunk) =>
			decoder.push(chunk),
		);
		expect(frames.map((frame) => frame.type)).toEqual([
			PtySubprocessIpcType.Spawn,
			PtySubprocessIpcType.Write,
		]);
		expect(frames[1]?.payload.toString("utf8")).toBe("queued input");
	});
});
