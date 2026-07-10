import { getTerminalColors, type Theme } from "./types";
import { toHex, withAlpha } from "./utils";

export interface EssentialThemeColors {
	background: string;
	surface: string;
	foreground: string;
	primary: string;
	border: string;
	terminalBackground: string;
}

export interface CustomizedThemeOptions {
	id: string;
	name: string;
	colors: EssentialThemeColors;
}

function relativeLuminance(color: string): number {
	const hex = toHex(color);
	const match = /^#([0-9a-f]{6})$/i.exec(hex);
	const hexValue = match?.[1];
	if (!hexValue) return 0;

	const channels = [0, 2, 4].map((offset) => {
		const value = Number.parseInt(hexValue.slice(offset, offset + 2), 16) / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	});
	return (
		0.2126 * (channels[0] ?? 0) +
		0.7152 * (channels[1] ?? 0) +
		0.0722 * (channels[2] ?? 0)
	);
}

export function getContrastRatio(first: string, second: string): number {
	const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
	const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
	return (lighter + 0.05) / (darker + 0.05);
}

function contrastingForeground(color: string): string {
	return relativeLuminance(color) > 0.179 ? "#000000" : "#ffffff";
}

export function getEssentialThemeColors(theme: Theme): EssentialThemeColors {
	const terminal = getTerminalColors(theme);
	return {
		background: toHex(theme.ui.background),
		surface: toHex(theme.ui.card),
		foreground: toHex(theme.ui.foreground),
		primary: toHex(theme.ui.primary),
		border: toHex(theme.ui.border),
		terminalBackground: toHex(terminal.background),
	};
}

/**
 * Build a complete custom theme from the small palette exposed in Appearance.
 * Related semantic colors move together so users do not have to edit every token.
 */
export function createCustomizedTheme(
	baseTheme: Theme,
	options: CustomizedThemeOptions,
): Theme {
	const {
		background,
		surface,
		foreground,
		primary,
		border,
		terminalBackground,
	} = options.colors;
	const primaryForeground = contrastingForeground(primary);
	const terminal = getTerminalColors(baseTheme);

	return {
		...baseTheme,
		id: options.id,
		name: options.name.trim(),
		author: "You",
		description: `Customized from ${baseTheme.name}`,
		isBuiltIn: false,
		isCustom: true,
		ui: {
			...baseTheme.ui,
			background,
			foreground,
			card: surface,
			cardForeground: foreground,
			popover: surface,
			popoverForeground: foreground,
			primary,
			primaryForeground,
			secondary: surface,
			secondaryForeground: foreground,
			muted: surface,
			mutedForeground: withAlpha(foreground, 0.68),
			accent: surface,
			accentForeground: foreground,
			tertiary: surface,
			tertiaryActive: border,
			border,
			input: border,
			ring: primary,
			sidebar: background,
			sidebarForeground: foreground,
			sidebarPrimary: primary,
			sidebarPrimaryForeground: primaryForeground,
			sidebarAccent: surface,
			sidebarAccentForeground: foreground,
			sidebarBorder: border,
			sidebarRing: primary,
			chart1: primary,
			highlightMatch: withAlpha(primary, 0.2),
			highlightActive: withAlpha(primary, 0.5),
		},
		terminal: {
			...terminal,
			background: terminalBackground,
			foreground,
			cursor: primary,
			cursorAccent: terminalBackground,
			selectionBackground: withAlpha(primary, 0.3),
			black: terminalBackground,
			white: foreground,
			brightWhite: foreground,
		},
	};
}
