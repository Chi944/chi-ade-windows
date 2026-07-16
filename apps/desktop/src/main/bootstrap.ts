import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, crashReporter } from "electron";
import {
	ensurePrivateDiagnosticsDirectory,
	getDiagnosticsLogger,
	initializeDiagnosticsLogger,
	logProcessFailure,
	resolveDiagnosticsCrashDirectory,
	resolveDiagnosticsLogDirectory,
} from "./lib/diagnostics/logger";
import { resolveLocalPrivateRoot } from "./lib/diagnostics/private-root";
import { acquireSingleInstanceLock } from "./lib/single-instance";

const PRIVATE_DIRECTORY_MODE = 0o700;

function defaultAdeHomeDirectory(): string {
	const rawWorkspace = process.env.SUPERSET_WORKSPACE_NAME;
	if (!rawWorkspace || rawWorkspace === "superset") {
		return join(homedir(), ".ade");
	}
	const workspace = rawWorkspace
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.slice(0, 32);
	return join(homedir(), workspace ? `.ade-${workspace}` : ".ade");
}

const adeHomeDir = process.env.ADE_HOME_DIR || defaultAdeHomeDirectory();
process.env.ADE_HOME_DIR = adeHomeDir;
mkdirSync(adeHomeDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });

const privateRoot = resolveLocalPrivateRoot({ adeHomeDir });
const diagnosticsLogDirectory = resolveDiagnosticsLogDirectory(privateRoot);
const diagnosticsCrashDirectory = resolveDiagnosticsCrashDirectory(privateRoot);
ensurePrivateDiagnosticsDirectory(diagnosticsLogDirectory);
ensurePrivateDiagnosticsDirectory(diagnosticsCrashDirectory);

// These paths must be fixed before any import can initialize local state or a
// database. userData intentionally retains ADE's existing per-home behavior.
app.setPath("userData", adeHomeDir);
app.setPath("crashDumps", diagnosticsCrashDirectory);
app.setAppLogsPath(diagnosticsLogDirectory);

let crashReporterFailure: unknown;
try {
	crashReporter.start({
		productName: "ADE",
		companyName: "ADE",
		uploadToServer: false,
		compress: false,
	});
} catch (error) {
	crashReporterFailure = error;
}

try {
	initializeDiagnosticsLogger({
		privateRoot,
		homePaths: [homedir(), adeHomeDir, privateRoot],
		mirrorToConsole: process.env.NODE_ENV === "development",
	});
} catch (error) {
	// Diagnostics must never become a second reason the application cannot open.
	// Detailed fallback output remains development-only because it is not passed
	// through the redactor when local logging itself is unavailable.
	if (process.env.NODE_ENV === "development") {
		console.error("[bootstrap] Could not initialize local diagnostics", error);
	}
}

if (crashReporterFailure !== undefined) {
	getDiagnosticsLogger().warn("crash-reporter.start.failed", {
		error: crashReporterFailure,
	});
}
getDiagnosticsLogger().info("bootstrap.ready", {
	crashUploadsEnabled: false,
});

// Monitor keeps Node's default fatal exception behavior while capturing the
// final local event. The rejection handler records non-fatal rejected promises.
process.on("uncaughtExceptionMonitor", (error, origin) => {
	logProcessFailure("uncaught-exception", { error, origin });
});
process.on("unhandledRejection", (reason) => {
	logProcessFailure("unhandled-rejection", reason);
});

const ownsSingleInstance = acquireSingleInstanceLock(() =>
	app.requestSingleInstanceLock(),
);
if (!ownsSingleInstance) {
	getDiagnosticsLogger().info("startup.secondary-instance", {
		bootAttemptRecorded: false,
	});
	app.exit(0);
} else {
	try {
		const recoveryDirectory = ensurePrivateDiagnosticsDirectory(
			join(privateRoot, "recovery"),
		);
		const { initializeBootState } = await import(
			"./lib/diagnostics/boot-state"
		);
		const bootStatus = await initializeBootState({
			filePath: join(recoveryDirectory, "boot-state.json"),
		});
		getDiagnosticsLogger()[bootStatus.recoveredCorruptState ? "warn" : "info"](
			"boot-state.starting",
			bootStatus,
		);
	} catch (error) {
		getDiagnosticsLogger().error("boot-state.initialize.failed", { error });
		throw error;
	}

	try {
		await import("./index");
	} catch (error) {
		logProcessFailure("bootstrap-import", error);
		throw error;
	}
}
