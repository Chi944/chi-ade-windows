const REDACTED = "[REDACTED]";
const HOME = "[HOME]";
const PROVIDER_PROFILE = "[PROVIDER_PROFILE]";
const CIRCULAR = "[CIRCULAR]";
const MAX_DEPTH = "[MAX_DEPTH]";
const MAX_REDACTION_DEPTH = 24;

export interface DiagnosticRedactionOptions {
	homePaths?: readonly string[];
}

const SECRET_KEY_SUFFIX =
	/(?:^|[-_.])(?:proxy[-_]?authorization|authorization|api[-_]?key|auth[-_]?token|access[-_]?key(?:[-_]?id)?|access[-_]?token|refresh[-_]?token|session[-_]?token|password|passwd|client[-_]?secret|private[-_]?key|secret[-_]?access[-_]?key|set[-_]?cookie|cookie|credentials?|secret|token)$/i;

const SECRET_CAMEL_CASE_SUFFIX =
	/(?:Authorization|ApiKey|AuthToken|AccessKey(?:Id)?|AccessToken|RefreshToken|SessionToken|Password|Passwd|ClientSecret|PrivateKey|SecretAccessKey|SetCookie|Cookie|Credentials?|Secret|Token)$/i;

const SECRET_QUERY_ALIAS = /^(?:key|auth|code|sig|signature|x-amz-signature)$/i;

function isSecretKey(key: string): boolean {
	const compact = key.replace(/\s+/g, "");
	return (
		SECRET_KEY_SUFFIX.test(compact) || SECRET_CAMEL_CASE_SUFFIX.test(compact)
	);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactUrls(value: string): string {
	return value.replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => {
		const trailing = candidate.match(/[),.;!?]+$/)?.[0] ?? "";
		const rawUrl = trailing ? candidate.slice(0, -trailing.length) : candidate;
		try {
			const url = new URL(rawUrl);
			url.username = "";
			url.password = "";
			for (const key of [...url.searchParams.keys()]) {
				if (isSecretKey(key) || SECRET_QUERY_ALIAS.test(key)) {
					url.searchParams.set(key, REDACTED);
				}
			}
			return `${url.toString()}${trailing}`;
		} catch {
			return candidate;
		}
	});
}

function redactHomePrefixes(
	value: string,
	homePaths: readonly string[],
): string {
	let redacted = value;
	for (const homePath of [...homePaths]
		.filter((candidate) => candidate.trim().length > 0)
		.sort((left, right) => right.length - left.length)) {
		redacted = redacted.replace(new RegExp(escapeRegExp(homePath), "gi"), HOME);
	}

	return redacted
		.replace(/\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"']+/gi, HOME)
		.replace(/\/Users\/[^/\s"']+/g, HOME)
		.replace(/\/home\/[^/\s"']+/g, HOME)
		.replace(/\/root(?=[/\\\s"']|$)/g, HOME);
}

/**
 * Remove credentials, local identities, and provider-private paths from text
 * before it crosses the diagnostics boundary.
 */
export function redactDiagnosticText(
	value: string,
	options: DiagnosticRedactionOptions = {},
): string {
	let redacted = redactUrls(value);
	redacted = redacted.replace(
		/^(\s*(?:x[-_]api[-_]?key|x[-_]auth[-_]?token|cookie|set[-_]?cookie)\s*[:=]\s*).*$/gim,
		(_match, prefix: string) => `${prefix}${REDACTED}`,
	);

	redacted = redacted.replace(
		/\b((?:proxy[-_])?authorization\s*[:=]\s*)(?:(?:bearer|basic)\s+)?[^\s,;]+/gi,
		(_match, prefix: string) => `${prefix}${REDACTED}`,
	);
	redacted = redacted.replace(
		/\b(bearer|basic)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
		(_match, scheme: string, spacing: string) =>
			`${scheme}${spacing}${REDACTED}`,
	);

	redacted = redacted
		.replace(/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, REDACTED)
		.replace(/\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g, REDACTED)
		.replace(/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, REDACTED)
		.replace(/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/g, REDACTED)
		.replace(/\bhf_[A-Za-z0-9_-]{16,}\b/g, REDACTED);

	redacted = redacted.replace(
		/(["']?)\b([A-Za-z][A-Za-z0-9_.-]*)\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}\]]+)/g,
		(
			match,
			keyQuote: string,
			key: string,
			separator: string,
			rawValue: string,
		) => {
			if (!isSecretKey(key)) return match;
			const valueQuote = rawValue.startsWith('"')
				? '"'
				: rawValue.startsWith("'")
					? "'"
					: "";
			return `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${REDACTED}${valueQuote}`;
		},
	);

	redacted = redactHomePrefixes(redacted, options.homePaths ?? []);

	return redacted.replace(
		/provider-accounts[\\/][^\\/\s"'?,;]+/gi,
		PROVIDER_PROFILE,
	);
}

function sanitizeDiagnosticValue(
	value: unknown,
	options: DiagnosticRedactionOptions,
	seen: WeakSet<object>,
	depth: number,
): unknown {
	if (depth > MAX_REDACTION_DEPTH) return MAX_DEPTH;
	if (value === null) return null;

	switch (typeof value) {
		case "string":
			return redactDiagnosticText(value, options);
		case "number":
		case "boolean":
			return value;
		case "bigint":
			return value.toString();
		case "undefined":
			return "[UNDEFINED]";
		case "symbol":
			return "[SYMBOL]";
		case "function":
			return "[FUNCTION]";
	}

	if (seen.has(value)) return CIRCULAR;
	seen.add(value);

	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
	}
	if (value instanceof RegExp) {
		return redactDiagnosticText(value.toString(), options);
	}
	if (value instanceof Error) {
		const error: Record<string, unknown> = {
			name: redactDiagnosticText(value.name, options),
			message: redactDiagnosticText(value.message, options),
		};
		if (value.stack) {
			error.stack = redactDiagnosticText(value.stack, options);
		}
		if (value.cause !== undefined) {
			error.cause = sanitizeDiagnosticValue(
				value.cause,
				options,
				seen,
				depth + 1,
			);
		}
		for (const key of Object.keys(value)) {
			if (key === "cause") continue;
			const safeKey = redactDiagnosticText(key, options);
			if (isSecretKey(key)) {
				error[safeKey] = REDACTED;
				continue;
			}
			try {
				error[safeKey] = sanitizeDiagnosticValue(
					(value as unknown as Record<string, unknown>)[key],
					options,
					seen,
					depth + 1,
				);
			} catch {
				error[safeKey] = "[UNREADABLE]";
			}
		}
		return error;
	}

	if (Array.isArray(value)) {
		return value.map((entry) =>
			sanitizeDiagnosticValue(entry, options, seen, depth + 1),
		);
	}

	if (value instanceof Map) {
		return [...value.entries()].map(([key, entry]) => [
			sanitizeDiagnosticValue(key, options, seen, depth + 1),
			sanitizeDiagnosticValue(entry, options, seen, depth + 1),
		]);
	}
	if (value instanceof Set) {
		return [...value].map((entry) =>
			sanitizeDiagnosticValue(entry, options, seen, depth + 1),
		);
	}

	const output: Record<string, unknown> = {};
	for (const key of Object.keys(value)) {
		const safeKey = redactDiagnosticText(key, options);
		if (isSecretKey(key)) {
			output[safeKey] = REDACTED;
			continue;
		}
		try {
			output[safeKey] = sanitizeDiagnosticValue(
				(value as Record<string, unknown>)[key],
				options,
				seen,
				depth + 1,
			);
		} catch {
			output[safeKey] = "[UNREADABLE]";
		}
	}
	return output;
}

/** Convert an arbitrary value into a JSON-safe, deeply redacted value. */
export function redactDiagnosticValue(
	value: unknown,
	options: DiagnosticRedactionOptions = {},
): unknown {
	return sanitizeDiagnosticValue(value, options, new WeakSet<object>(), 0);
}
