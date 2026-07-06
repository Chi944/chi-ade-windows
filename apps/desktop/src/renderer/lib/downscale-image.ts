/**
 * Downscale a user-picked image to a small square-ish JPEG data URL before it
 * is sent over IPC and stored. A raw phone photo is several MB — larger than
 * the icon store's hard cap — so we rasterize it to at most MAX_DIM on the long
 * edge and re-encode as WebP. Category/agent thumbnails are tiny, so this loses
 * nothing visible while keeping payloads ~10-30KB.
 */
const MAX_DIM = 256;
// WebP keeps payloads tiny AND preserves transparency (a logo PNG would go
// black as JPEG). Chromium (Electron) encodes it natively.
const OUTPUT_TYPE = "image/webp";
const OUTPUT_QUALITY = 0.85;
/** Reject absurd source files before we even decode them (raw bytes, ~40MB). */
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;

function readAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () =>
			typeof reader.result === "string"
				? resolve(reader.result)
				: reject(new Error("Could not read image"));
		reader.onerror = () => reject(reader.error ?? new Error("Read failed"));
		reader.readAsDataURL(file);
	});
}

function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("Could not decode image"));
		img.src = src;
	});
}

/**
 * Returns a JPEG data URL scaled to fit within MAX_DIM x MAX_DIM. Throws with a
 * user-facing message if the file is not a decodable image or is unreasonably
 * large.
 */
export async function downscaleImageToDataUrl(file: File): Promise<string> {
	if (file.size > MAX_SOURCE_BYTES) {
		throw new Error(
			`Image is too large (${Math.round(file.size / (1024 * 1024))}MB). Please pick one under 40MB.`,
		);
	}

	const original = await readAsDataUrl(file);
	const img = await loadImage(original);

	const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
	if (!longEdge) throw new Error("Could not read image dimensions");

	const scale = Math.min(1, MAX_DIM / longEdge);
	const w = Math.max(1, Math.round(img.naturalWidth * scale));
	const h = Math.max(1, Math.round(img.naturalHeight * scale));

	const canvas = document.createElement("canvas");
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext("2d");
	if (!ctx) return original;
	ctx.drawImage(img, 0, 0, w, h);

	return canvas.toDataURL(OUTPUT_TYPE, OUTPUT_QUALITY);
}
