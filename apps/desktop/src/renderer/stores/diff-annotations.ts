import type { ChangeCategory, GitChangesStatus } from "shared/changes-types";
import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

export type DiffAnnotationSide = "original" | "modified";

export interface DiffAnnotation {
	id: string;
	worktreePath: string;
	filePath: string;
	category: ChangeCategory;
	commitHash?: string;
	side: DiffAnnotationSide;
	line: number;
	body: string;
	createdAt: number;
	resolved: boolean;
}

export interface NewDiffAnnotation {
	worktreePath: string;
	filePath: string;
	category: ChangeCategory;
	commitHash?: string;
	side: DiffAnnotationSide;
	line: number;
	body: string;
}

export const MAX_DIFF_ANNOTATIONS = 500;

function diffIdentity(
	category: ChangeCategory,
	filePath: string,
	commitHash = "",
): string {
	return JSON.stringify([category, filePath, commitHash]);
}

export function getActiveDiffAnnotations(
	worktreePath: string,
	status: GitChangesStatus,
	annotations: DiffAnnotation[],
): DiffAnnotation[] {
	const active = new Set<string>();
	for (const file of status.againstBase) {
		active.add(diffIdentity("against-base", file.path));
	}
	for (const file of status.staged) {
		active.add(diffIdentity("staged", file.path));
	}
	for (const file of [...status.unstaged, ...status.untracked]) {
		active.add(diffIdentity("unstaged", file.path));
	}
	for (const commit of status.commits) {
		for (const file of commit.files) {
			active.add(diffIdentity("committed", file.path, commit.hash));
		}
	}
	return annotations.filter(
		(annotation) =>
			annotation.worktreePath === worktreePath &&
			active.has(
				diffIdentity(
					annotation.category,
					annotation.filePath,
					annotation.commitHash,
				),
			),
	);
}

interface DiffAnnotationsState {
	annotations: DiffAnnotation[];
	addAnnotation: (annotation: NewDiffAnnotation) => void;
	setResolved: (id: string, resolved: boolean) => void;
	removeAnnotation: (id: string) => void;
	clearResolved: (worktreePath: string) => void;
}

export function annotationMatchesFile(
	annotation: DiffAnnotation,
	input: {
		worktreePath: string;
		filePath: string;
		category: ChangeCategory;
		commitHash?: string;
	},
): boolean {
	return (
		annotation.worktreePath === input.worktreePath &&
		annotation.filePath === input.filePath &&
		annotation.category === input.category &&
		(annotation.commitHash ?? "") === (input.commitHash ?? "")
	);
}

export function buildDiffReviewPrompt(
	worktreePath: string,
	annotations: DiffAnnotation[],
): string {
	const unresolved = annotations
		.filter(
			(annotation) =>
				annotation.worktreePath === worktreePath && !annotation.resolved,
		)
		.sort(
			(a, b) =>
				a.filePath.localeCompare(b.filePath) ||
				a.line - b.line ||
				a.createdAt - b.createdAt,
		);

	if (unresolved.length === 0) return "";

	return [
		"Please address the following ADE diff review notes. Preserve unrelated changes and report how each note was resolved.",
		"",
		...unresolved.map(
			(annotation, index) =>
				`${index + 1}. ${annotation.filePath}:${annotation.line} (${annotation.side}, ${annotation.category})\n   ${annotation.body}`,
		),
	].join("\n");
}

export const useDiffAnnotationsStore = create<DiffAnnotationsState>()(
	devtools(
		persist(
			(set) => ({
				annotations: [],
				addAnnotation: (annotation) =>
					set((state) => ({
						annotations: [
							...state.annotations,
							{
								...annotation,
								id: crypto.randomUUID(),
								body: annotation.body.trim(),
								line: Math.max(1, Math.trunc(annotation.line)),
								createdAt: Date.now(),
								resolved: false,
							},
						].slice(-MAX_DIFF_ANNOTATIONS),
					})),
				setResolved: (id, resolved) =>
					set((state) => ({
						annotations: state.annotations.map((annotation) =>
							annotation.id === id ? { ...annotation, resolved } : annotation,
						),
					})),
				removeAnnotation: (id) =>
					set((state) => ({
						annotations: state.annotations.filter(
							(annotation) => annotation.id !== id,
						),
					})),
				clearResolved: (worktreePath) =>
					set((state) => ({
						annotations: state.annotations.filter(
							(annotation) =>
								annotation.worktreePath !== worktreePath ||
								!annotation.resolved,
						),
					})),
			}),
			{
				name: "diff-annotations",
				version: 1,
				partialize: (state) => ({ annotations: state.annotations }),
			},
		),
		{ name: "DiffAnnotationsStore" },
	),
);
