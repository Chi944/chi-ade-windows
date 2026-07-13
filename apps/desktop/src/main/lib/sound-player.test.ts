import { describe, expect, it } from "bun:test";
import {
	createSoundPlaybackCommand,
	startSoundPlayback,
} from "./sound-player";

describe("sound player", () => {
	it("uses WPF MediaPlayer for Windows MP3 playback without interpolating paths", () => {
		const soundPath = "C:\\Users\\Ada's Music\\notification.mp3";
		const command = createSoundPlaybackCommand(soundPath, "win32");
		const script = command.args.at(-1) ?? "";

		expect(command.file).toBe("powershell.exe");
		expect(command.args).toContain("-STA");
		expect(script).toContain("System.Windows.Media.MediaPlayer");
		expect(script).not.toContain("System.Media.SoundPlayer");
		expect(script).not.toContain(soundPath);
		expect(command.options?.env?.ADE_AUDIO_FILE_PATH).toBe(soundPath);
		expect(command.readyMarker).toBe("ADE_AUDIO_READY");
	});

	it("uses the native macOS player", () => {
		expect(createSoundPlaybackCommand("/tmp/ping.mp3", "darwin")).toEqual({
			file: "afplay",
			args: ["/tmp/ping.mp3"],
		});
	});

	it("starts with PulseAudio on Linux", () => {
		expect(createSoundPlaybackCommand("/tmp/ping.mp3", "linux")).toEqual({
			file: "paplay",
			args: ["/tmp/ping.mp3"],
		});
	});

	it("fails immediately when the selected sound is missing", () => {
		expect(() =>
			startSoundPlayback("Z:\\this-path-does-not-exist\\missing.mp3"),
		).toThrow("Sound file not found");
	});
});
