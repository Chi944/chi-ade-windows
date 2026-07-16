import { describe, expect, test } from "bun:test";
import { redactDiagnosticText, redactDiagnosticValue } from "./redaction";

const REDACTED = "[REDACTED]";

describe("redactDiagnosticText", () => {
	test("redacts bearer and basic authorization headers case-insensitively", () => {
		const input = [
			"Authorization: Bearer bearer-secret-value",
			"proxy-authorization=Basic dXNlcjpwYXNzd29yZA==",
		].join("\n");

		const redacted = redactDiagnosticText(input);

		expect(redacted).not.toContain("bearer-secret-value");
		expect(redacted).not.toContain("dXNlcjpwYXNzd29yZA==");
		expect(redacted.match(/\[REDACTED\]/g)).toHaveLength(2);
	});

	test("redacts prefixed API/auth headers and cookie headers", () => {
		const secrets = [
			"prefix-api-secret",
			"prefix-auth-secret",
			"session-cookie-secret",
			"response-cookie-secret",
		];
		const input = [
			`X-Api-Key: ${secrets[0]}`,
			`x-auth-token=${secrets[1]}`,
			`Cookie: session=${secrets[2]}; theme=dark`,
			`Set-Cookie: auth=${secrets[3]}; Secure; HttpOnly`,
		].join("\n");

		const redacted = redactDiagnosticText(input);

		for (const secret of secrets) expect(redacted).not.toContain(secret);
		expect(redacted.match(/\[REDACTED\]/g)).toHaveLength(4);
	});

	test("redacts GitHub, OpenAI, Anthropic, and Hugging Face token shapes", () => {
		const secrets = [
			"ghp_0123456789abcdefghijklmnopqrstuvwxyz",
			"github_pat_11AA0123456789abcdefghijklmnopqrstuvwxyz",
			"sk-proj-0123456789abcdefghijklmnopqrstuvwxyz",
			"sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz",
			"hf_0123456789abcdefghijklmnopqrstuvwxyz",
		];

		const redacted = redactDiagnosticText(`tokens: ${secrets.join(" ")}`);

		for (const secret of secrets) expect(redacted).not.toContain(secret);
		expect(redacted.match(/\[REDACTED\]/g)).toHaveLength(secrets.length);
	});

	test("redacts common secret key/value syntax without hiding ordinary values", () => {
		const input =
			'api_key="key-value" accessToken: token-value password=pwd client_secret = "client-value" retries=3';

		const redacted = redactDiagnosticText(input);

		for (const secret of ["key-value", "token-value", "pwd", "client-value"]) {
			expect(redacted).not.toContain(secret);
		}
		expect(redacted).toContain("retries=3");
	});

	test("redacts JSON-quoted secret keys without changing safe JSON fields", () => {
		const input = JSON.stringify({
			refresh_token: "oauth-secret-123456",
			password: "pw-secret",
			retries: 3,
			message: "provider check completed",
		});

		expect(redactDiagnosticText(input)).toBe(
			JSON.stringify({
				refresh_token: REDACTED,
				password: REDACTED,
				retries: 3,
				message: "provider check completed",
			}),
		);
	});

	test("redacts provider-prefixed environment-style secret assignments", () => {
		const secrets = [
			"openai-env-secret",
			"anthropic-env-secret",
			"github-env-secret",
			"hf-env-secret",
			"aws-env-secret",
		];
		const input = [
			`OPENAI_API_KEY=${secrets[0]}`,
			`anthropicApiKey: ${secrets[1]}`,
			`GITHUB_TOKEN='${secrets[2]}'`,
			`HF_ACCESS_TOKEN="${secrets[3]}"`,
			`AWS_SECRET_ACCESS_KEY=${secrets[4]}`,
			"RETRY_COUNT=3",
		].join(" ");

		const redacted = redactDiagnosticText(input);

		for (const secret of secrets) expect(redacted).not.toContain(secret);
		expect(redacted).toContain("RETRY_COUNT=3");
	});

	test("removes URL user information and secret query values", () => {
		const input =
			"request https://alice:p%40ss@example.test/v1/models?limit=10&api_key=url-secret&access_token=access-secret";

		const redacted = redactDiagnosticText(input);

		expect(redacted).not.toContain("alice");
		expect(redacted).not.toContain("p%40ss");
		expect(redacted).not.toContain("url-secret");
		expect(redacted).not.toContain("access-secret");
		expect(redacted).toContain("example.test/v1/models");
		expect(redacted).toContain("limit=10");
	});

	test("redacts bare key, auth, code, and signature query parameters", () => {
		const secrets = ["key-secret", "auth-secret", "code-secret", "sig-secret"];
		const input = `https://example.test/callback?key=${secrets[0]}&auth=${secrets[1]}&code=${secrets[2]}&sig=${secrets[3]}&page=2`;

		const redacted = redactDiagnosticText(input);

		for (const secret of secrets) expect(redacted).not.toContain(secret);
		expect(redacted).toContain("page=2");
	});

	test("redacts Windows, macOS, and Linux home prefixes", () => {
		const redacted = redactDiagnosticText(
			[
				String.raw`C:\Users\Alice\Documents\project`,
				"/Users/bob/Code/project",
				"/home/carol/src/project",
				"/root/private/project",
			].join("\n"),
		);

		for (const identity of ["Alice", "bob", "carol", "/root"]) {
			expect(redacted).not.toContain(identity);
		}
		expect(redacted.match(/\[HOME\]/g)).toHaveLength(4);
	});

	test("redacts configured home aliases and provider profile paths", () => {
		const home = String.raw`D:\Portable\Chi Home`;
		const profileId = "3d659817-4d35-47f4-a5e3-64eebff679ac";
		const input = `${home}\\.ade\\state.json ${home}\\ADE\\private\\abc123\\provider-accounts\\${profileId}\\.claude.json`;

		const redacted = redactDiagnosticText(input, { homePaths: [home] });

		expect(redacted).not.toContain(home);
		expect(redacted).not.toContain(profileId);
		expect(redacted).toContain("[HOME]");
		expect(redacted).toContain("[PROVIDER_PROFILE]");
	});

	test("leaves safe ordinary messages unchanged", () => {
		const message = "terminal exited cleanly after 3 retries";
		expect(redactDiagnosticText(message)).toBe(message);
	});
});

describe("redactDiagnosticValue", () => {
	test("redacts nested secret fields and Error details", () => {
		const error = new Error(
			String.raw`failed for sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz at C:\Users\Alice\project`,
		);
		error.cause = {
			authorization: "Bearer nested-bearer-secret",
			context: { apiKey: "nested-key-secret", attempts: 2 },
		};

		const redacted = redactDiagnosticValue({ error }) as {
			error: {
				name: string;
				message: string;
				stack: string;
				cause: unknown;
			};
		};
		const serialized = JSON.stringify(redacted);

		expect(redacted.error.name).toBe("Error");
		expect(redacted.error.message).toContain(REDACTED);
		expect(redacted.error.stack).toContain(REDACTED);
		for (const secret of [
			"nested-bearer-secret",
			"nested-key-secret",
			"Alice",
		]) {
			expect(serialized).not.toContain(secret);
		}
		expect(serialized).toContain('"attempts":2');
	});

	test("serializes circular values without throwing or exposing a secret", () => {
		const value: Record<string, unknown> = {
			message: "safe",
			password: "circular-secret",
		};
		value.self = value;

		const redacted = redactDiagnosticValue(value);
		const serialized = JSON.stringify(redacted);

		expect(serialized).toContain('"message":"safe"');
		expect(serialized).toContain('"password":"[REDACTED]"');
		expect(serialized).toContain('"self":"[CIRCULAR]"');
		expect(serialized).not.toContain("circular-secret");
	});

	test("redacts prefixed and cookie-shaped secret object fields", () => {
		const redacted = redactDiagnosticValue({
			"x-api-key": "object-api-secret",
			"x-auth-token": "object-auth-secret",
			cookie: "session=object-cookie-secret",
			"set-cookie": "session=object-response-cookie-secret",
			status: "ready",
		});
		const serialized = JSON.stringify(redacted);

		for (const secret of [
			"object-api-secret",
			"object-auth-secret",
			"object-cookie-secret",
			"object-response-cookie-secret",
		]) {
			expect(serialized).not.toContain(secret);
		}
		expect(serialized).toContain('"status":"ready"');
	});

	test("redacts provider-prefixed secret object fields", () => {
		const redacted = redactDiagnosticValue({
			OPENAI_API_KEY: "object-openai-secret",
			anthropicApiKey: "object-anthropic-secret",
			GITHUB_TOKEN: "object-github-secret",
			AWS_SECRET_ACCESS_KEY: "object-aws-secret",
			RETRY_COUNT: 3,
		});
		const serialized = JSON.stringify(redacted);

		for (const secret of [
			"object-openai-secret",
			"object-anthropic-secret",
			"object-github-secret",
			"object-aws-secret",
		]) {
			expect(serialized).not.toContain(secret);
		}
		expect(serialized).toContain('"RETRY_COUNT":3');
	});
});
