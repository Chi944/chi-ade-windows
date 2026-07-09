import { spawnSync } from "node:child_process";

function run(command: string, args: string[]): void {
	const result = spawnSync(command, args, {
		stdio: "inherit",
		shell: process.platform === "win32",
	});

	if (result.error) {
		console.error(result.error);
		process.exit(1);
	}

	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

if (process.env.SUPERSET_POSTINSTALL_RUNNING) {
	process.exit(0);
}

process.env.SUPERSET_POSTINSTALL_RUNNING = "1";

run("sherif", []);

if (process.platform === "win32") {
	// ADE's Windows native dependencies publish Electron-compatible prebuilds.
	// Rebuilding them here pulls in a multi-gigabyte Visual Studio/Spectre
	// toolchain and fails on otherwise valid lean Windows setups. The packaging
	// flow validates the shipped binaries with `smoke:native` instead.
	console.info("[postinstall] Using prebuilt Windows native modules");
} else {
	run(process.execPath, ["run", "--filter=@ade/desktop", "install:deps"]);
}
