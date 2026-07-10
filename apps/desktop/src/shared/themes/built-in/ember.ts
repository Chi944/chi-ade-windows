import type { Theme } from "../types";

/**
 * True-black dark theme optimized for OLED screens and low-light Windows use.
 */
export const darkTheme: Theme = {
	id: "dark",
	name: "True Black",
	author: "ADE",
	description: "A deep OLED-friendly dark theme",
	type: "dark",
	isBuiltIn: true,

	ui: {
		// Core - true black canvas with subtle near-black surfaces
		background: "#000000",
		foreground: "#f4f4f5",
		card: "#090909",
		cardForeground: "#f4f4f5",
		popover: "#0c0c0c",
		popoverForeground: "#f4f4f5",

		// Primary - high-contrast neutral actions
		primary: "#f4f4f5",
		primaryForeground: "#000000",

		// Secondary - neutral near-black surfaces
		secondary: "#171717",
		secondaryForeground: "#f4f4f5",

		// Muted - legible without glowing against black
		muted: "#171717",
		mutedForeground: "#a1a1aa",

		accent: "#171717",
		accentForeground: "#f4f4f5",

		// Tertiary - panel backgrounds
		tertiary: "#050505",
		tertiaryActive: "#151515",

		// Destructive - warm red
		destructive: "#cc4444",
		destructiveForeground: "#ffcccc",

		// Borders - visible separation without lifting the black canvas
		border: "#262626",
		input: "#262626",
		ring: "#d4d4d8",

		// Sidebar - near-black, distinct from the main canvas
		sidebar: "#030303",
		sidebarForeground: "#f4f4f5",
		sidebarPrimary: "#e07850",
		sidebarPrimaryForeground: "#000000",
		sidebarAccent: "#151515",
		sidebarAccentForeground: "#f4f4f5",
		sidebarBorder: "#262626",
		sidebarRing: "#d4d4d8",

		// Charts - warm palette
		chart1: "#e07850",
		chart2: "#50a878",
		chart3: "#d4a84b",
		chart4: "#7b68ee",
		chart5: "#dc6b6b",

		// Search highlights - warm orange tint matching the accent palette
		highlightMatch: "rgba(224, 120, 80, 0.2)",
		highlightActive: "rgba(224, 120, 80, 0.5)",
	},

	terminal: {
		background: "#000000",
		foreground: "#f4f4f5",
		cursor: "#e07850",
		cursorAccent: "#000000",
		selectionBackground: "rgba(224, 120, 80, 0.25)",

		// Standard ANSI colors
		black: "#000000",
		red: "#dc6b6b",
		green: "#7ec699",
		yellow: "#e5c07b",
		blue: "#61afef",
		magenta: "#c678dd",
		cyan: "#56b6c2",
		white: "#f4f4f5",

		// Bright ANSI colors
		brightBlack: "#5c5856",
		brightRed: "#e88888",
		brightGreen: "#98d1a8",
		brightYellow: "#ecd08f",
		brightBlue: "#7ec0f5",
		brightMagenta: "#d494e6",
		brightCyan: "#73c7d3",
		brightWhite: "#ffffff",
	},
};
