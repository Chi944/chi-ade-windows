const UTF8_BYTES_PER_ESTIMATED_TOKEN = 3;

export const DEFAULT_CONTEXT_PACKET_TOKEN_BUDGET = 1_200;
export const MAX_CONTEXT_PACKET_TOKEN_BUDGET = 4_096;

export interface ContextPacketInput {
	objective?: string;
	summary?: string;
	decisions?: readonly string[];
	files?: readonly string[];
	commands?: readonly string[];
	blockers?: readonly string[];
	nextSteps?: readonly string[];
	artifacts?: readonly string[];
}

export interface ContextPacketOptions {
	maxEstimatedTokens?: number;
}

export interface ContextPacket {
	content: string;
	estimatedTokens: number;
	truncated: boolean;
}

const textEncoder = new TextEncoder();

function utf8ByteLength(value: string): number {
	return textEncoder.encode(value).length;
}

/**
 * A deliberately conservative, tokenizer-independent estimate that works for
 * ASCII and multibyte text without loading a model-specific tokenizer.
 */
export function estimateContextTokens(value: string): number {
	if (!value) return 0;
	return Math.ceil(utf8ByteLength(value) / UTF8_BYTES_PER_ESTIMATED_TOKEN);
}

function normalizeText(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.replace(/\r\n?/g, "\n").trim();
	return normalized || undefined;
}

function normalizeItem(value: string): string | undefined {
	const normalized = normalizeText(value)?.replace(/\s*\n\s*/g, " ");
	return normalized || undefined;
}

function uniqueItems(values: readonly string[] | undefined): string[] {
	if (!values) return [];

	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const normalized = normalizeItem(value);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		result.push(normalized);
	}
	return result;
}

function addTextSection(
	sections: string[],
	heading: string,
	value: string | undefined,
): void {
	const normalized = normalizeText(value);
	if (normalized) sections.push(`## ${heading}\n${normalized}`);
}

function addListSection(
	sections: string[],
	heading: string,
	values: readonly string[] | undefined,
): void {
	const items = uniqueItems(values);
	if (items.length > 0) {
		sections.push(
			`## ${heading}\n${items.map((item) => `- ${item}`).join("\n")}`,
		);
	}
}

function resolveTokenBudget(requested: number | undefined): number {
	if (requested === undefined || !Number.isFinite(requested)) {
		return DEFAULT_CONTEXT_PACKET_TOKEN_BUDGET;
	}
	return Math.min(
		MAX_CONTEXT_PACKET_TOKEN_BUDGET,
		Math.max(1, Math.floor(requested)),
	);
}

function truncateToUtf8Bytes(value: string, maxBytes: number): string {
	if (utf8ByteLength(value) <= maxBytes) return value;

	const marker = "…";
	const markerBytes = utf8ByteLength(marker);
	if (maxBytes < markerBytes) return "";

	const contentLimit = maxBytes - markerBytes;
	let bytesUsed = 0;
	let prefix = "";
	for (const character of value) {
		const characterBytes = utf8ByteLength(character);
		if (bytesUsed + characterBytes > contentLimit) break;
		prefix += character;
		bytesUsed += characterBytes;
	}

	return `${prefix.trimEnd()}${marker}`;
}

/** Build a deterministic handoff packet without retaining raw chat history. */
export function buildContextPacket(
	input: ContextPacketInput,
	options: ContextPacketOptions = {},
): ContextPacket {
	const sections: string[] = [];
	addTextSection(sections, "Objective", input.objective);
	// Put actionable state first so a large background summary cannot truncate
	// the handoff instructions that the receiving agent needs to continue.
	addListSection(sections, "Next steps", input.nextSteps);
	addListSection(sections, "Blockers", input.blockers);
	addListSection(sections, "Decisions", input.decisions);
	addListSection(sections, "Artifacts", input.artifacts);
	addListSection(sections, "Files", input.files);
	addListSection(sections, "Commands", input.commands);
	addTextSection(sections, "Summary", input.summary);

	const completeContent = sections.join("\n\n");
	const tokenBudget = resolveTokenBudget(options.maxEstimatedTokens);
	const content = truncateToUtf8Bytes(
		completeContent,
		tokenBudget * UTF8_BYTES_PER_ESTIMATED_TOKEN,
	);

	return {
		content,
		estimatedTokens: estimateContextTokens(content),
		truncated: content !== completeContent,
	};
}
