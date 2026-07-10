import { Button } from "@superset/ui/button";
import { Checkbox } from "@superset/ui/checkbox";
import { Collapsible, CollapsibleContent } from "@superset/ui/collapsible";
import { Input } from "@superset/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { Textarea } from "@superset/ui/textarea";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LuFileCode, LuLoader, LuTrash2 } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useChangesStore } from "renderer/stores/changes";
import {
	annotationMatchesFile,
	type DiffAnnotationSide,
	useDiffAnnotationsStore,
} from "renderer/stores/diff-annotations";
import type { ChangeCategory, ChangedFile } from "shared/changes-types";
import { getStatusColor, getStatusIndicator } from "../../../shared/file-utils";
import { createFileKey, useScrollContext } from "../../context";
import { DiffViewer } from "../DiffViewer";
import { LightDiffViewer } from "../LightDiffViewer";
import { FileDiffHeader } from "./components/FileDiffHeader";
import { useFileDiffEdit } from "./hooks/useFileDiffEdit";

interface FileDiffSectionProps {
	file: ChangedFile;
	category: ChangeCategory;
	commitHash?: string;
	worktreePath: string;
	baseBranch?: string;
	isExpanded: boolean;
	onToggleExpanded: () => void;
	onStage?: () => void;
	onUnstage?: () => void;
	onDiscard?: () => void;
	isActioning?: boolean;
}

const VISIBILITY_MARGIN = "200px 0px";
const LARGE_DIFF_THRESHOLD = 500;

const GENERATED_FILE_PATTERNS = [
	/^bun\.lock(b)?$/,
	/^package-lock\.json$/,
	/^yarn\.lock$/,
	/^pnpm-lock\.yaml$/,
	/^composer\.lock$/,
	/^Gemfile\.lock$/,
	/^Cargo\.lock$/,
	/^poetry\.lock$/,
	/^Pipfile\.lock$/,
	/^go\.sum$/,
	/\.min\.(js|css)$/,
	/\.bundle\.(js|css)$/,
	/[\\/]vendor[\\/]/,
	/[\\/]node_modules[\\/]/,
	/[\\/]dist[\\/]/,
	/[\\/]build[\\/]/,
];

function isGeneratedFile(filePath: string): boolean {
	const fileName = filePath.split("/").pop() || filePath;
	return GENERATED_FILE_PATTERNS.some(
		(pattern) => pattern.test(fileName) || pattern.test(filePath),
	);
}

export function FileDiffSection({
	file,
	category,
	commitHash,
	worktreePath,
	baseBranch,
	isExpanded,
	onToggleExpanded,
	onStage,
	onUnstage,
	onDiscard,
	isActioning = false,
}: FileDiffSectionProps) {
	const sectionRef = useRef<HTMLDivElement>(null);
	const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const {
		registerFileRef,
		viewedFiles,
		setFileViewed,
		setActiveFileKey,
		containerRef,
	} = useScrollContext();
	const { viewMode: diffViewMode, hideUnchangedRegions } = useChangesStore();
	const [isCopied, setIsCopied] = useState(false);
	const [hasBeenVisible, setHasBeenVisible] = useState(false);
	const [loadHiddenDiff, setLoadHiddenDiff] = useState(false);
	const [annotationsOpen, setAnnotationsOpen] = useState(false);
	const [annotationLine, setAnnotationLine] = useState("1");
	const [annotationSide, setAnnotationSide] =
		useState<DiffAnnotationSide>("modified");
	const [annotationBody, setAnnotationBody] = useState("");
	const allAnnotations = useDiffAnnotationsStore((state) => state.annotations);
	const annotations = useMemo(
		() =>
			allAnnotations.filter((annotation) =>
				annotationMatchesFile(annotation, {
					worktreePath,
					filePath: file.path,
					category,
					commitHash,
				}),
			),
		[allAnnotations, worktreePath, file.path, category, commitHash],
	);
	const addAnnotation = useDiffAnnotationsStore((state) => state.addAnnotation);
	const setAnnotationResolved = useDiffAnnotationsStore(
		(state) => state.setResolved,
	);
	const removeAnnotation = useDiffAnnotationsStore(
		(state) => state.removeAnnotation,
	);

	const { isEditing, toggleEdit, handleSave } = useFileDiffEdit({
		category,
		worktreePath,
		filePath: file.path,
	});

	const totalChanges = file.additions + file.deletions;
	const isLargeDiff = totalChanges > LARGE_DIFF_THRESHOLD;
	const isGenerated = isGeneratedFile(file.path);
	const isHiddenByDefault = isLargeDiff || isGenerated;

	const fileKey = createFileKey(file, category, commitHash);
	const isViewed = viewedFiles.has(fileKey);

	const openInEditorMutation =
		electronTrpc.external.openFileInEditor.useMutation();

	const handleOpenInEditor = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			if (worktreePath) {
				const absolutePath = `${worktreePath}/${file.path}`;
				openInEditorMutation.mutate({ path: absolutePath, cwd: worktreePath });
			}
		},
		[worktreePath, file.path, openInEditorMutation],
	);

	const handleCopyPath = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			navigator.clipboard
				.writeText(file.path)
				.then(() => {
					setIsCopied(true);
					if (copyTimeoutRef.current) {
						clearTimeout(copyTimeoutRef.current);
					}
					copyTimeoutRef.current = setTimeout(() => setIsCopied(false), 2000);
				})
				.catch((err) => {
					console.error("[FileDiffSection/copyPath] Failed to copy:", err);
				});
		},
		[file.path],
	);

	useEffect(() => {
		return () => {
			if (copyTimeoutRef.current) {
				clearTimeout(copyTimeoutRef.current);
			}
		};
	}, []);

	const handleViewedChange = useCallback(
		(checked: boolean) => {
			setFileViewed(fileKey, checked);
			if (checked && isExpanded) {
				onToggleExpanded();
			} else if (!checked && !isExpanded) {
				onToggleExpanded();
			}
		},
		[fileKey, setFileViewed, isExpanded, onToggleExpanded],
	);

	useEffect(() => {
		registerFileRef(file, category, commitHash, sectionRef.current);
		return () => {
			registerFileRef(file, category, commitHash, null);
		};
	}, [file, category, commitHash, registerFileRef]);

	useEffect(() => {
		const element = sectionRef.current;
		const container = containerRef.current;
		if (!element || !container) return;

		const activeObserver = new IntersectionObserver(
			([entry]) => {
				if (entry.isIntersecting && entry.intersectionRatio > 0.1) {
					setActiveFileKey(fileKey);
				}
			},
			{
				root: container,
				rootMargin: "-100px 0px -60% 0px",
				threshold: [0.1],
			},
		);

		const visibilityObserver = new IntersectionObserver(
			([entry]) => {
				if (entry.isIntersecting) {
					setHasBeenVisible(true);
				}
			},
			{ root: container, rootMargin: VISIBILITY_MARGIN },
		);

		activeObserver.observe(element);
		visibilityObserver.observe(element);

		return () => {
			activeObserver.disconnect();
			visibilityObserver.disconnect();
		};
	}, [fileKey, setActiveFileKey, containerRef]);

	const { data: diffData, isLoading: isLoadingDiff } =
		electronTrpc.changes.getFileContents.useQuery(
			{
				worktreePath,
				filePath: file.path,
				oldPath: file.oldPath,
				category,
				commitHash,
				defaultBranch: category === "against-base" ? baseBranch : undefined,
			},
			{
				enabled:
					isExpanded &&
					(!isHiddenByDefault || loadHiddenDiff) &&
					!!worktreePath,
			},
		);

	const statusBadgeColor = getStatusColor(file.status);
	const statusIndicator = getStatusIndicator(file.status);
	const showStats = file.additions > 0 || file.deletions > 0;

	const shouldRenderEditor = hasBeenVisible && diffData;
	const parsedAnnotationLine = Number.parseInt(annotationLine, 10);
	const canAddAnnotation =
		Number.isInteger(parsedAnnotationLine) &&
		parsedAnnotationLine > 0 &&
		annotationBody.trim().length > 0;

	const handleAddAnnotation = () => {
		if (!canAddAnnotation) return;
		addAnnotation({
			worktreePath,
			filePath: file.path,
			category,
			commitHash,
			side: annotationSide,
			line: parsedAnnotationLine,
			body: annotationBody,
		});
		setAnnotationBody("");
	};

	return (
		<div
			ref={sectionRef}
			className="mx-2 my-2 border border-border rounded-lg overflow-hidden"
		>
			<Collapsible open={isExpanded} onOpenChange={onToggleExpanded}>
				<FileDiffHeader
					file={file}
					fileKey={fileKey}
					isExpanded={isExpanded}
					onToggleExpanded={onToggleExpanded}
					isViewed={isViewed}
					onViewedChange={handleViewedChange}
					statusBadgeColor={statusBadgeColor}
					statusIndicator={statusIndicator}
					showStats={showStats}
					onOpenInEditor={handleOpenInEditor}
					onCopyPath={handleCopyPath}
					isCopied={isCopied}
					isEditing={isEditing}
					onToggleEdit={toggleEdit}
					annotationCount={annotations.filter((note) => !note.resolved).length}
					onToggleAnnotations={() => setAnnotationsOpen((open) => !open)}
					annotationsOpen={annotationsOpen}
					onStage={onStage}
					onUnstage={onUnstage}
					onDiscard={onDiscard}
					isActioning={isActioning}
				/>

				{annotationsOpen && (
					<div className="space-y-3 border-b bg-violet-500/[0.04] p-3">
						<div className="grid gap-2 sm:grid-cols-[110px_90px_1fr_auto] sm:items-end">
							<div className="space-y-1">
								<span className="text-xs text-muted-foreground">Side</span>
								<Select
									value={annotationSide}
									onValueChange={(value) =>
										setAnnotationSide(value as DiffAnnotationSide)
									}
								>
									<SelectTrigger className="h-8">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="modified">New</SelectItem>
										<SelectItem value="original">Original</SelectItem>
									</SelectContent>
								</Select>
							</div>
							<div className="space-y-1">
								<label
									htmlFor={`annotation-line-${fileKey}`}
									className="text-xs text-muted-foreground"
								>
									Line
								</label>
								<Input
									id={`annotation-line-${fileKey}`}
									type="number"
									min={1}
									className="h-8"
									value={annotationLine}
									onChange={(event) => setAnnotationLine(event.target.value)}
								/>
							</div>
							<Textarea
								value={annotationBody}
								onChange={(event) => setAnnotationBody(event.target.value)}
								placeholder="Describe what the agent should change..."
								rows={2}
								maxLength={2000}
								className="min-h-8 resize-y"
							/>
							<Button
								size="sm"
								disabled={!canAddAnnotation}
								onClick={handleAddAnnotation}
							>
								Add note
							</Button>
						</div>

						{annotations.length > 0 && (
							<div className="space-y-1.5">
								{annotations.map((annotation) => (
									<div
										key={annotation.id}
										className="flex items-start gap-2 rounded-md border bg-background/80 px-2.5 py-2"
									>
										<Checkbox
											checked={annotation.resolved}
											onCheckedChange={(checked) =>
												setAnnotationResolved(annotation.id, checked === true)
											}
											aria-label="Mark review note resolved"
											className="mt-0.5"
										/>
										<div className="min-w-0 flex-1">
											<p className="text-[11px] font-medium text-violet-400">
												{annotation.side === "modified" ? "New" : "Original"}
												line {annotation.line}
											</p>
											<p
												className={`text-xs ${annotation.resolved ? "text-muted-foreground line-through" : "text-foreground"}`}
											>
												{annotation.body}
											</p>
										</div>
										<button
											type="button"
											onClick={() => removeAnnotation(annotation.id)}
											className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
											aria-label="Delete review note"
										>
											<LuTrash2 className="size-3.5" />
										</button>
									</div>
								))}
							</div>
						)}
					</div>
				)}

				<CollapsibleContent>
					{isHiddenByDefault && !loadHiddenDiff ? (
						<div className="flex flex-col items-center justify-center gap-3 py-8 text-muted-foreground bg-muted/30">
							<LuFileCode className="w-8 h-8" />
							<p className="text-sm">
								{isGenerated
									? "Generated file hidden"
									: `Large diff hidden — ${totalChanges.toLocaleString()} lines changed`}
							</p>
							<Button
								variant="outline"
								size="sm"
								onClick={() => setLoadHiddenDiff(true)}
							>
								Load diff
							</Button>
						</div>
					) : isLoadingDiff ? (
						<div className="flex items-center justify-center h-24 text-muted-foreground bg-background">
							<LuLoader className="w-4 h-4 animate-spin mr-2" />
							<span>Loading diff...</span>
						</div>
					) : shouldRenderEditor ? (
						isEditing ? (
							<DiffViewer
								contents={diffData}
								viewMode={diffViewMode}
								hideUnchangedRegions={hideUnchangedRegions}
								filePath={file.path}
								editable
								onSave={handleSave}
								fitContent
								captureScroll={false}
							/>
						) : (
							<LightDiffViewer
								contents={diffData}
								viewMode={diffViewMode}
								hideUnchangedRegions={hideUnchangedRegions}
								filePath={file.path}
							/>
						)
					) : (
						<div className="flex items-center justify-center h-24 text-muted-foreground bg-background">
							{diffData ? (
								<>
									<LuLoader className="w-4 h-4 animate-spin mr-2" />
									<span>Loading editor...</span>
								</>
							) : (
								"Unable to load diff"
							)}
						</div>
					)}
				</CollapsibleContent>
			</Collapsible>
		</div>
	);
}
