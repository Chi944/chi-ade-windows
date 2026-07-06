/**
 * Brand colors for the agent-fleet "Space" model. Each Space (a domain rail
 * item) tints its agent busts with shades of its brand color so the fleet is
 * visually grouped. Keyed by the Space project's name.
 */
export const SPACE_BRAND_COLORS: Record<string, string> = {
	YouTube: "#FF0000",
	"AI for Mortals": "#D9B775", // cream / tan
	LinkedIn: "#0A66C2",
	Substack: "#FF6719",
	Advisory: "#F5B700", // accent yellow
	"Instagram & TikTok": "#E1306C",
};

function hexToRgb(hex: string): [number, number, number] {
	const h = hex.replace("#", "");
	return [
		Number.parseInt(h.slice(0, 2), 16),
		Number.parseInt(h.slice(2, 4), 16),
		Number.parseInt(h.slice(4, 6), 16),
	];
}

function rgbToHex(r: number, g: number, b: number): string {
	const c = (n: number) =>
		Math.max(0, Math.min(255, Math.round(n)))
			.toString(16)
			.padStart(2, "0");
	return `#${c(r)}${c(g)}${c(b)}`;
}

/** Mix a color toward white (amount 0..1). */
function lighten(hex: string, amount: number): string {
	const [r, g, b] = hexToRgb(hex);
	return rgbToHex(
		r + (255 - r) * amount,
		g + (255 - g) * amount,
		b + (255 - b) * amount,
	);
}

/**
 * Returns the tint color for an agent bust tile within a Space.
 * Later agents get progressively lighter shades of the brand color so each
 * is distinguishable. Returns null when the Space has no brand color (so the
 * bust renders without a colored tile).
 */
export function getSpaceTint(
	spaceName: string,
	index: number,
	total: number,
): string | null {
	const base = SPACE_BRAND_COLORS[spaceName];
	if (!base) return null;
	if (total <= 1) return base;
	// Spread shades across 0 .. 0.45 lightness so the darkest is the pure brand
	// color and the lightest is a soft tint.
	const amount = (index / Math.max(1, total - 1)) * 0.45;
	return lighten(base, amount);
}
