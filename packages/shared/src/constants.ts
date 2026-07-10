// Auth
export const AUTH_PROVIDERS = ["github", "google"] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

// Deep link protocol schemes (used for desktop OAuth callbacks)
export const PROTOCOL_SCHEMES = {
	DEV: "ade-dev",
	PROD: "ade",
} as const;

// Company
export const COMPANY = {
	NAME: "ADE",
	DOMAIN: "github.com",
	EMAIL_DOMAIN: "@chi-ade.invalid",
	GITHUB_URL: "https://github.com/Chi944/chi-ade-windows",
	DOCS_URL:
		process.env.NEXT_PUBLIC_DOCS_URL ||
		"https://github.com/Chi944/chi-ade-windows#readme",
	MARKETING_URL:
		process.env.NEXT_PUBLIC_MARKETING_URL ||
		"https://github.com/Chi944/chi-ade-windows",
	TERMS_URL: "https://github.com/Chi944/chi-ade-windows/blob/main/LICENSE.md",
	PRIVACY_URL: "https://github.com/Chi944/chi-ade-windows/security",
	CHANGELOG_URL: "https://github.com/Chi944/chi-ade-windows/releases",
	X_URL: "https://github.com/Chi944/chi-ade-windows",
	MAIL_TO: "https://github.com/Chi944/chi-ade-windows/issues/new",
	REPORT_ISSUE_URL: "https://github.com/Chi944/chi-ade-windows/issues/new",
	DISCORD_URL: "https://github.com/Chi944/chi-ade-windows/discussions",
} as const;

// Theme
export const THEME_STORAGE_KEY = "ade-theme";

// Download URLs
export const DOWNLOAD_URL_MAC_ARM64 = `${COMPANY.GITHUB_URL}/releases/latest/download/ADE-arm64.dmg`;

// Auth token configuration
export const TOKEN_CONFIG = {
	/** Access token lifetime in seconds (1 hour) */
	ACCESS_TOKEN_EXPIRY: 60 * 60,
	/** Refresh token lifetime in seconds (30 days) */
	REFRESH_TOKEN_EXPIRY: 30 * 24 * 60 * 60,
	/** Refresh access token when this many seconds remain (5 minutes) */
	REFRESH_THRESHOLD: 5 * 60,
} as const;

// PostHog
export const POSTHOG_COOKIE_NAME = "ade";

export const FEATURE_FLAGS = {
	/** Gates access to experimental Electric SQL tasks feature. */
	ELECTRIC_TASKS_ACCESS: "electric-tasks-access",
	/** Gates access to GitHub integration (currently buggy, internal only). */
	GITHUB_INTEGRATION_ACCESS: "github-integration-access",
	/** Gates access to AI chat (@superset.sh internal only). */
	AI_CHAT: "ai-chat",
	/** Gates access to Slack integration (internal only). */
	SLACK_INTEGRATION_ACCESS: "slack-integration-access",
	/** Gates access to Cloud features (environment variables, sandboxes). */
	CLOUD_ACCESS: "cloud-access",
} as const;
