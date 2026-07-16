import type {
	HealthCheckResult,
	HealthGroup,
	HealthReport,
	HealthStatus,
} from "main/lib/diagnostics/health";

const GROUP_ORDER: HealthGroup[] = [
	"storage",
	"state",
	"tools",
	"accounts",
	"notifications",
	"remote",
	"updates",
	"recovery",
];

const GROUP_LABELS: Record<HealthGroup, string> = {
	storage: "Storage",
	state: "State & database",
	tools: "Tools & agents",
	accounts: "Provider accounts",
	notifications: "Notifications",
	remote: "Remote work",
	updates: "Updates",
	recovery: "Recovery",
};

const STATUS_PRIORITY: Record<HealthStatus, number> = {
	pass: 0,
	warning: 1,
	fail: 2,
};

export type HealthStatusTone = "success" | "warning" | "danger";

export interface HealthGroupViewModel {
	id: HealthGroup;
	label: string;
	status: HealthStatus;
	checks: HealthCheckResult[];
}

export interface HealthViewModel {
	overallStatus: HealthStatus | "unknown";
	summary: HealthReport["summary"];
	groups: HealthGroupViewModel[];
	generatedAt: string | null;
}

function worstStatus(checks: HealthCheckResult[]): HealthStatus {
	return checks.reduce<HealthStatus>(
		(worst, check) =>
			STATUS_PRIORITY[check.status] > STATUS_PRIORITY[worst]
				? check.status
				: worst,
		"pass",
	);
}

export function buildHealthViewModel(
	report: HealthReport | undefined,
): HealthViewModel {
	if (!report) {
		return {
			overallStatus: "unknown",
			summary: { pass: 0, warning: 0, fail: 0 },
			groups: [],
			generatedAt: null,
		};
	}

	const groups = GROUP_ORDER.flatMap((group): HealthGroupViewModel[] => {
		const checks = report.checks.filter((check) => check.group === group);
		return checks.length === 0
			? []
			: [
					{
						id: group,
						label: GROUP_LABELS[group],
						status: worstStatus(checks),
						checks,
					},
				];
	});

	return {
		overallStatus:
			report.summary.fail > 0
				? "fail"
				: report.summary.warning > 0
					? "warning"
					: "pass",
		summary: { ...report.summary },
		groups,
		generatedAt: report.generatedAt,
	};
}

export function getHealthStatusPresentation(status: HealthStatus): {
	label: string;
	tone: HealthStatusTone;
} {
	switch (status) {
		case "pass":
			return { label: "Pass", tone: "success" };
		case "warning":
			return { label: "Warning", tone: "warning" };
		case "fail":
			return { label: "Fail", tone: "danger" };
	}
}
