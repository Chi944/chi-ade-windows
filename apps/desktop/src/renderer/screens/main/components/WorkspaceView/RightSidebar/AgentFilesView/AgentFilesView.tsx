import { useParams } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { LuFileText } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";

type AgentFileGroup = "Memory" | "Skills" | "Worktree";

interface AgentFileEntry {
	label: string;
	group: AgentFileGroup;
	absolutePath: string;
	relativeToWorktree: string | null;
}

const GROUP_ORDER: AgentFileGroup[] = ["Memory", "Skills", "Worktree"];

export function AgentFilesView() {
	const { workspaceId } = useParams({ strict: false });
	const { data: files, isLoading } =
		electronTrpc.workspaces.listAgentFiles.useQuery(
			{ workspaceId: workspaceId ?? "" },
			{ enabled: !!workspaceId },
		);

	const addFileViewerPane = useTabsStore((s) => s.addFileViewerPane);

	const handleActivate = useCallback(
		(entry: AgentFileEntry) => {
			if (!workspaceId) return;
			// In-worktree files open via the worktree-relative path; out-of-worktree
			// memory/skill files open via their absolute path. Both are pinned so
			// they persist as real tabs.
			if (entry.relativeToWorktree) {
				addFileViewerPane(workspaceId, {
					filePath: entry.relativeToWorktree,
					isPinned: true,
				});
				return;
			}
			addFileViewerPane(workspaceId, {
				filePath: entry.label,
				absolutePath: entry.absolutePath,
				isPinned: true,
			});
		},
		[workspaceId, addFileViewerPane],
	);

	const grouped = useMemo(() => {
		const map = new Map<AgentFileGroup, AgentFileEntry[]>();
		for (const entry of files ?? []) {
			const list = map.get(entry.group) ?? [];
			list.push(entry);
			map.set(entry.group, list);
		}
		return map;
	}, [files]);

	if (!workspaceId) {
		return (
			<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-4">
				No agent selected
			</div>
		);
	}

	if (isLoading) {
		return (
			<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-4">
				Loading agent files…
			</div>
		);
	}

	if (!files || files.length === 0) {
		return (
			<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-4">
				No agent files yet
			</div>
		);
	}

	return (
		<div className="flex flex-col flex-1 min-h-0 overflow-auto py-1">
			{GROUP_ORDER.map((group) => {
				const entries = grouped.get(group);
				if (!entries || entries.length === 0) return null;
				return (
					<div key={group} className="flex flex-col">
						<div className="px-3 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
							{group}
						</div>
						{entries.map((entry) => (
							<button
								key={entry.absolutePath}
								type="button"
								onClick={() => handleActivate(entry)}
								className="flex items-center gap-2 px-3 py-1 text-sm text-left text-foreground/90 hover:bg-tertiary/20 transition-colors"
								title={entry.absolutePath}
							>
								<LuFileText className="size-3.5 shrink-0 text-muted-foreground" />
								<span className="truncate">{entry.label}</span>
							</button>
						))}
					</div>
				);
			})}
		</div>
	);
}
