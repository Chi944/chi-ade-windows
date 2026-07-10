import { screen } from "electron";

// Narrow wrapper so unit tests can replace Electron without mutating Bun's
// process-wide module mock for unrelated suites.
export { screen };
