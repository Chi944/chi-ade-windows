import {
	type ChildProcess,
	type ExecFileOptions,
	execFile,
} from "node:child_process";
import { existsSync } from "node:fs";

const WINDOWS_READY_MARKER = "ADE_AUDIO_READY";
const WINDOWS_SOUND_PATH_ENV = "ADE_AUDIO_FILE_PATH";

const WINDOWS_MEDIA_PLAYER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore

$player = [System.Windows.Media.MediaPlayer]::new()
try {
	$player.Open([Uri]$env:${WINDOWS_SOUND_PATH_ENV})
	$deadline = [DateTime]::UtcNow.AddSeconds(5)
	while (-not $player.NaturalDuration.HasTimeSpan) {
		if ([DateTime]::UtcNow -ge $deadline) {
			throw 'Timed out while loading notification audio'
		}
		Start-Sleep -Milliseconds 25
	}

	[Console]::Out.WriteLine('${WINDOWS_READY_MARKER}')
	[Console]::Out.Flush()
	$player.Play()
	$durationMs = [int][Math]::Ceiling($player.NaturalDuration.TimeSpan.TotalMilliseconds + 100)
	Start-Sleep -Milliseconds $durationMs
}
finally {
	$player.Close()
}
`.trim();

export interface SoundPlaybackCommand {
	file: string;
	args: string[];
	options?: ExecFileOptions;
	readyMarker?: string;
}

export interface SoundPlaybackHandle {
	/** Resolves once the player has accepted the file without a decode error. */
	started: Promise<void>;
	stop: () => void;
}

interface SoundPlaybackOptions {
	onComplete?: () => void;
	onError?: (error: Error) => void;
}

export function createSoundPlaybackCommand(
	soundPath: string,
	platform: NodeJS.Platform = process.platform,
): SoundPlaybackCommand {
	if (platform === "darwin") {
		return { file: "afplay", args: [soundPath] };
	}

	if (platform === "win32") {
		return {
			file: "powershell.exe",
			args: [
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-STA",
				"-Command",
				WINDOWS_MEDIA_PLAYER_SCRIPT,
			],
			options: {
				env: {
					...process.env,
					[WINDOWS_SOUND_PATH_ENV]: soundPath,
				},
				windowsHide: true,
			},
			readyMarker: WINDOWS_READY_MARKER,
		};
	}

	return { file: "paplay", args: [soundPath] };
}

function createPlaybackError(
	command: SoundPlaybackCommand,
	error: Error,
	stderr: string,
): Error {
	const detail = stderr.trim() || error.message;
	return new Error(
		`Could not play notification audio with ${command.file}: ${detail}`,
	);
}

/**
 * Starts a platform-native audio player without invoking a shell.
 *
 * Windows uses WPF MediaPlayer rather than System.Media.SoundPlayer because all
 * built-in ADE sounds are MP3 files. The file path is passed through the child
 * environment so quotes and other path characters never enter PowerShell code.
 */
export function startSoundPlayback(
	soundPath: string,
	options: SoundPlaybackOptions = {},
): SoundPlaybackHandle {
	if (!existsSync(soundPath)) {
		throw new Error(`Sound file not found: ${soundPath}`);
	}

	let activeProcess: ChildProcess | null = null;
	let stopped = false;
	let startedSettled = false;
	let resolveStarted: () => void = () => {};
	let rejectStarted: (error: Error) => void = () => {};
	const started = new Promise<void>((resolve, reject) => {
		resolveStarted = resolve;
		rejectStarted = reject;
	});

	const markStarted = () => {
		if (startedSettled) return;
		startedSettled = true;
		resolveStarted();
	};
	const reportError = (error: Error) => {
		if (!startedSettled) {
			startedSettled = true;
			rejectStarted(error);
		}
		options.onError?.(error);
	};

	const launch = (command: SoundPlaybackCommand, linuxFallback: boolean) => {
		let startupOutput = "";
		const child = execFile(
			command.file,
			command.args,
			command.options ?? {},
			(error, _stdout, stderr) => {
				if (activeProcess === child) activeProcess = null;
				if (stopped) return;

				if (error && linuxFallback) {
					launch({ file: "aplay", args: [soundPath] }, false);
					return;
				}

				if (error) {
					reportError(createPlaybackError(command, error, String(stderr)));
					return;
				}

				if (!startedSettled) {
					if (command.readyMarker) {
						reportError(
							new Error(
								`${command.file} exited before notification audio started`,
							),
						);
						return;
					}
					// afplay/paplay do not expose a decode-ready signal. A clean exit is
					// the only reliable proof that a custom file was playable.
					markStarted();
				}
				options.onComplete?.();
			},
		);
		activeProcess = child;

		if (command.readyMarker) {
			child.stdout?.on("data", (chunk) => {
				startupOutput += String(chunk);
				if (startupOutput.includes(command.readyMarker ?? "")) markStarted();
			});
		}
	};

	const command = createSoundPlaybackCommand(soundPath);
	launch(
		command,
		process.platform !== "darwin" && process.platform !== "win32",
	);

	return {
		started,
		stop: () => {
			if (stopped) return;
			stopped = true;
			// Treat an intentional stop as a successful start so callers waiting for
			// the Windows decode handshake do not retain a pending promise.
			markStarted();
			activeProcess?.kill("SIGKILL");
			activeProcess = null;
		},
	};
}
