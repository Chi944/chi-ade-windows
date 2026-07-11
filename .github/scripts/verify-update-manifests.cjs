#!/usr/bin/env node

const { createHash } = require("node:crypto");
const {
	createReadStream,
	existsSync,
	readFileSync,
	statSync,
} = require("node:fs");
const { basename, dirname, isAbsolute, join } = require("node:path");

const manifestPaths = process.argv.slice(2);

if (manifestPaths.length === 0) {
	throw new Error("Pass at least one updater manifest path");
}

function parseScalar(raw, label) {
	const value = raw.trim();
	if (!value) throw new Error(`${label} is empty`);
	if (value.startsWith('"') && value.endsWith('"')) {
		return JSON.parse(value);
	}
	if (value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1).replaceAll("''", "'");
	}
	return value;
}

function topLevelValue(text, key, manifestPath) {
	const match = text.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"));
	if (!match) throw new Error(`${manifestPath}: missing top-level ${key}`);
	return parseScalar(match[1], `${manifestPath}: ${key}`);
}

function fileEntries(text, manifestPath) {
	const lines = text.split(/\r?\n/);
	const entries = [];

	for (let index = 0; index < lines.length; index += 1) {
		const urlMatch = lines[index].match(/^ {2}- url:\s*(.+?)\s*$/);
		if (!urlMatch) continue;

		let sha512;
		for (let child = index + 1; child < lines.length; child += 1) {
			if (/^(?: {2}- |\S)/.test(lines[child])) break;
			const hashMatch = lines[child].match(/^ {4}sha512:\s*(.+?)\s*$/);
			if (hashMatch) {
				sha512 = parseScalar(hashMatch[1], `${manifestPath}: files[].sha512`);
				break;
			}
		}

		if (!sha512) {
			throw new Error(`${manifestPath}: files entry is missing sha512`);
		}
		entries.push({
			url: parseScalar(urlMatch[1], `${manifestPath}: files[].url`),
			sha512,
		});
	}

	if (entries.length === 0) {
		throw new Error(`${manifestPath}: files list is empty or malformed`);
	}
	return entries;
}

function artifactName(raw, label) {
	let decoded;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		throw new Error(`${label}: invalid URL encoding`);
	}
	if (
		isAbsolute(decoded) ||
		decoded !== basename(decoded) ||
		decoded.includes("/") ||
		decoded.includes("\\")
	) {
		throw new Error(`${label}: artifact path must be a plain filename`);
	}
	return decoded;
}

function assertExpectedTarget(manifestPath, name) {
	const manifest = basename(manifestPath);
	const checks = {
		"latest.yml": (value) => /-x64\.exe$/i.test(value),
		"latest-arm64-mac.yml": (value) => /-arm64\.zip$/i.test(value),
		"latest-x64-mac.yml": (value) => /-x64\.zip$/i.test(value),
		"latest-linux.yml": (value) => /-(?:x64|x86_64)\.AppImage$/.test(value),
	};
	const check = checks[manifest];
	if (check && !check(name)) {
		throw new Error(`${manifestPath}: unexpected target artifact ${name}`);
	}
}

function sha512(filePath) {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha512");
		createReadStream(filePath)
			.on("error", reject)
			.on("data", (chunk) => hash.update(chunk))
			.on("end", () => resolve(hash.digest("base64")));
	});
}

async function verifyManifest(manifestPath) {
	if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
		throw new Error(`${manifestPath}: manifest does not exist`);
	}

	const text = readFileSync(manifestPath, "utf8");
	const pathName = artifactName(
		topLevelValue(text, "path", manifestPath),
		`${manifestPath}: path`,
	);
	const expectedHash = topLevelValue(text, "sha512", manifestPath);
	const entries = fileEntries(text, manifestPath);
	assertExpectedTarget(manifestPath, pathName);

	const matchingEntry = entries.find(
		(entry) =>
			artifactName(entry.url, `${manifestPath}: files[].url`) === pathName &&
			entry.sha512 === expectedHash,
	);
	if (!matchingEntry) {
		throw new Error(
			`${manifestPath}: top-level path/sha512 does not match a files entry`,
		);
	}

	for (const entry of entries) {
		const name = artifactName(entry.url, `${manifestPath}: files[].url`);
		const filePath = join(dirname(manifestPath), name);
		if (!existsSync(filePath) || !statSync(filePath).isFile()) {
			throw new Error(
				`${manifestPath}: referenced artifact is missing: ${name}`,
			);
		}
		const actualHash = await sha512(filePath);
		if (actualHash !== entry.sha512) {
			throw new Error(`${manifestPath}: SHA-512 mismatch for ${name}`);
		}
	}

	console.log(`verified updater manifest: ${manifestPath}`);
}

Promise.all(manifestPaths.map(verifyManifest)).catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
