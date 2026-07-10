import { describe, expect, it } from "bun:test";
import { darkTheme, lightTheme } from "./built-in";
import {
	createCustomizedTheme,
	getContrastRatio,
	getEssentialThemeColors,
} from "./customize";

describe("getEssentialThemeColors", () => {
	it("normalizes CSS colors for native color inputs", () => {
		const colors = getEssentialThemeColors(lightTheme);

		expect(colors.background).toBe("#ffffff");
		expect(colors.foreground).toMatch(/^#[0-9a-f]{6}$/);
		expect(colors.terminalBackground).toBe("#ffffff");
	});
});

describe("getContrastRatio", () => {
	it("measures accessible true-black text contrast", () => {
		expect(getContrastRatio("#ffffff", "#000000")).toBe(21);
		expect(getContrastRatio("#111111", "#000000")).toBeLessThan(4.5);
	});
});

describe("createCustomizedTheme", () => {
	it("maps an essential palette to related UI and terminal colors", () => {
		const customized = createCustomizedTheme(darkTheme, {
			id: "custom-test",
			name: "  My Theme  ",
			colors: {
				background: "#010203",
				surface: "#111213",
				foreground: "#f1f2f3",
				primary: "#ffcc00",
				border: "#303132",
				terminalBackground: "#040506",
			},
		});

		expect(customized.name).toBe("My Theme");
		expect(customized.isBuiltIn).toBe(false);
		expect(customized.isCustom).toBe(true);
		expect(customized.ui.background).toBe("#010203");
		expect(customized.ui.card).toBe("#111213");
		expect(customized.ui.sidebarPrimary).toBe("#ffcc00");
		expect(customized.ui.primaryForeground).toBe("#000000");
		expect(customized.ui.border).toBe("#303132");
		expect(customized.terminal?.background).toBe("#040506");
		expect(customized.terminal?.cursor).toBe("#ffcc00");
	});

	it("does not mutate the base theme", () => {
		const originalBackground = darkTheme.ui.background;
		createCustomizedTheme(darkTheme, {
			id: "custom-test",
			name: "My Theme",
			colors: {
				...getEssentialThemeColors(darkTheme),
				background: "#123456",
			},
		});

		expect(darkTheme.ui.background).toBe(originalBackground);
	});
});
