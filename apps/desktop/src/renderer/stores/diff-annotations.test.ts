import { describe, expect, it } from "bun:test";
import {
	annotationMatchesFile,
	buildDiffReviewPrompt,
	type DiffAnnotation,
	getActiveDiffAnnotations,
} from "./diff-annotations";

const annotation: DiffAnnotation = {
	id: "note-1",
	worktreePath: "C:/repo/worktree",
	filePath: "src/app.ts",
	category: "unstaged",
	side: "modified",
	line: 12,
	body: "Handle the empty state.",
	createdAt: 1,
	resolved: false,
};

describe("diff annotations", () => {
	it("matches notes only to the exact diff identity", () => {
		expect(
			annotationMatchesFile(annotation, {
				worktreePath: "C:/repo/worktree",
				filePath: "src/app.ts",
				category: "unstaged",
			}),
		).toBe(true);
		expect(
			annotationMatchesFile(annotation, {
				worktreePath: "C:/repo/worktree",
				filePath: "src/app.ts",
				category: "staged",
			}),
		).toBe(false);
	});

	it("builds a deterministic unresolved review prompt", () => {
		const resolved = { ...annotation, id: "note-2", resolved: true };
		const prompt = buildDiffReviewPrompt(annotation.worktreePath, [
			resolved,
			annotation,
		]);
		expect(prompt).toContain("src/app.ts:12 (modified, unstaged)");
		expect(prompt).toContain("Handle the empty state.");
		expect(prompt).not.toContain("note-2");
	});

	it("excludes notes whose exact diff is no longer visible", () => {
		const active = getActiveDiffAnnotations(
			annotation.worktreePath,
			{
				branch: "main",
				defaultBranch: "main",
				againstBase: [],
				commits: [],
				staged: [
					{
						path: annotation.filePath,
						status: "modified",
						additions: 1,
						deletions: 0,
					},
				],
				unstaged: [],
				untracked: [],
				ahead: 0,
				behind: 0,
				pushCount: 0,
				pullCount: 0,
				hasUpstream: false,
			},
			[annotation, { ...annotation, id: "staged", category: "staged" }],
		);
		expect(active.map((item) => item.id)).toEqual(["staged"]);
	});
});
