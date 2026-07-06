import type {
	SelectTask,
	SelectTaskStatus,
	SelectUser,
} from "@superset/db/schema";
import { Badge } from "@superset/ui/badge";
import { Checkbox } from "@superset/ui/checkbox";
import { cn } from "@superset/ui/utils";
import { eq, isNull } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import {
	type ColumnFiltersState,
	createColumnHelper,
	type ExpandedState,
	getCoreRowModel,
	getExpandedRowModel,
	getFilteredRowModel,
	getGroupedRowModel,
	type RowSelectionState,
	type Table,
	useReactTable,
} from "@tanstack/react-table";
import {
	differenceInDays,
	differenceInHours,
	differenceInMinutes,
	format,
	isBefore,
	startOfDay,
} from "date-fns";
import { useEffect, useMemo, useRef, useState } from "react";
import { HiChevronRight } from "react-icons/hi2";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { create } from "zustand";
import {
	StatusIcon,
	type StatusType,
} from "../../components/shared/StatusIcon";
import type { TabValue } from "../../components/TasksTopBar";
import { compareTasks } from "../../utils/sorting";
import { useHybridSearch } from "../useHybridSearch";
import { AssigneeCell } from "./components/AssigneeCell";
import { PriorityCell } from "./components/PriorityCell";
import { StatusCell } from "./components/StatusCell";

export type TaskWithStatus = SelectTask & {
	status: SelectTaskStatus;
	assignee: SelectUser | null;
};

const columnHelper = createColumnHelper<TaskWithStatus>();

const useRowSelectionStore = create<{
	rowSelection: RowSelectionState;
	setRowSelection: (
		updater:
			| RowSelectionState
			| ((prev: RowSelectionState) => RowSelectionState),
	) => void;
}>((set) => ({
	rowSelection: {},
	setRowSelection: (updater) =>
		set((state) => ({
			rowSelection:
				typeof updater === "function" ? updater(state.rowSelection) : updater,
		})),
}));

/**
 * Format a date as relative time: "5m ago", "3h ago", "2d ago", or "Mar 5" for older.
 */
function formatRelativeTime(date: Date): string {
	const now = new Date();
	const diffMinutes = differenceInMinutes(now, date);
	const diffHours = differenceInHours(now, date);
	const diffDays = differenceInDays(now, date);

	if (diffMinutes < 1) return "now";
	if (diffMinutes < 60) return `${diffMinutes}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	if (diffDays < 7) return `${diffDays}d ago`;
	return format(date, "MMM d");
}

/**
 * Check if a status type is "done" (completed or canceled).
 */
function isDoneStatus(statusType: string): boolean {
	return statusType === "completed" || statusType === "canceled";
}

interface UseTasksTableParams {
	filterTab: TabValue;
	searchQuery: string;
	assigneeFilter: string | null;
	projectFilter: string[];
}

export function useTasksTable({
	filterTab,
	searchQuery,
	assigneeFilter,
	projectFilter,
}: UseTasksTableParams): {
	table: Table<TaskWithStatus>;
	isLoading: boolean;
	slugColumnWidth: string;
	rowSelection: RowSelectionState;
	setRowSelection: (
		updater:
			| RowSelectionState
			| ((prev: RowSelectionState) => RowSelectionState),
	) => void;
} {
	const collections = useCollections();
	const [grouping, setGrouping] = useState<string[]>(["status"]);
	const [expanded, setExpanded] = useState<ExpandedState>(true);
	const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
	const rowSelection = useRowSelectionStore((s) => s.rowSelection);
	const setRowSelection = useRowSelectionStore((s) => s.setRowSelection);

	const { data: allData, isLoading } = useLiveQuery(
		(q) =>
			q
				.from({ tasks: collections.tasks })
				.innerJoin({ status: collections.taskStatuses }, ({ tasks, status }) =>
					eq(tasks.statusId, status.id),
				)
				.leftJoin({ assignee: collections.users }, ({ tasks, assignee }) =>
					eq(tasks.assigneeId, assignee.id),
				)
				.select(({ tasks, status, assignee }) => ({
					...tasks,
					status,
					assignee: assignee ?? null,
				}))
				.where(({ tasks }) => isNull(tasks.deletedAt)),
		[collections],
	);

	const sortedData = useMemo(() => {
		if (!allData) return [];
		return [...allData].sort(compareTasks);
	}, [allData]);

	const { search } = useHybridSearch(sortedData);

	const searchedData = useMemo(() => {
		if (!searchQuery.trim()) {
			return sortedData;
		}
		const results = search(searchQuery);
		return results.map((r) => r.item);
	}, [sortedData, searchQuery, search]);

	const data = useMemo(() => {
		if (projectFilter.length === 0) return searchedData;
		return searchedData.filter((task) => {
			const projectName = task.externalProvider;
			if (projectFilter.includes("__none__")) {
				if (!projectName) return true;
			}
			if (projectName && projectFilter.includes(projectName)) return true;
			return false;
		});
	}, [searchedData, projectFilter]);

	const isFirstMount = useRef(true);
	useEffect(() => {
		const newColumnFilters: ColumnFiltersState = [];
		if (filterTab !== "all") {
			newColumnFilters.push({
				id: "status",
				value: filterTab,
			});
		}
		if (assigneeFilter !== null) {
			newColumnFilters.push({
				id: "assigneeId",
				value: assigneeFilter,
			});
		}
		setColumnFilters(newColumnFilters);
		if (isFirstMount.current) {
			isFirstMount.current = false;
		} else {
			setRowSelection({});
		}
	}, [filterTab, assigneeFilter, setRowSelection]);

	const slugColumnWidth = useMemo(() => {
		if (!data || data.length === 0) return "5rem";

		const longestSlug = data.reduce((longest, task) => {
			return task.slug.length > longest.length ? task.slug : longest;
		}, "");

		const REM_PER_CHAR = 0.5 * 0.75;
		const PADDING_REM = 0.5;
		const width = longestSlug.length * REM_PER_CHAR + PADDING_REM;

		return `${Math.ceil(width * 10) / 10}rem`;
	}, [data]);

	const columns = useMemo(
		() => [
			// Hidden grouping column - used for status groups but not rendered as a data cell
			columnHelper.accessor((row) => row.status, {
				id: "status",
				header: "Status",
				filterFn: (row, _columnId, filterValue: TabValue) => {
					const statusType = row.original.status.type;
					if (filterValue === "active") {
						return statusType === "started" || statusType === "unstarted";
					}
					if (filterValue === "backlog") {
						return statusType === "backlog";
					}
					return true;
				},
				cell: (info) => {
					const { row, cell } = info;
					const status = info.getValue();

					if (cell.getIsGrouped()) {
						return (
							<div
								className="w-full"
								style={{
									background: `linear-gradient(90deg, ${status.color}14 0%, transparent 100%)`,
								}}
							>
								<button
									type="button"
									className="group w-full justify-start px-4 py-2 h-auto relative rounded-none bg-transparent flex items-center cursor-pointer border-0"
									onClick={row.getToggleExpandedHandler()}
								>
									<HiChevronRight
										className={`h-3 w-3 text-muted-foreground transition-transform duration-100 group-hover:text-foreground ${
											row.getIsExpanded() ? "rotate-90" : ""
										}`}
									/>
									<div className="flex items-center gap-2 pl-4">
										<StatusIcon
											type={status.type as StatusType}
											color={status.color}
											progress={status.progressPercent ?? undefined}
										/>
										<span className="text-sm font-medium capitalize">
											{status.name}
										</span>
										<span className="text-xs text-muted-foreground">
											{row.subRows.length}
										</span>
									</div>
								</button>
							</div>
						);
					}

					return null;
				},
				getGroupingValue: (row) => row.status.name,
			}),

			// 1. Checkbox (24px)
			columnHelper.display({
				id: "checkbox",
				header: "",
				cell: ({ row }) => {
					if (row.getIsGrouped()) return null;
					return (
						<Checkbox
							checked={row.getIsSelected()}
							onCheckedChange={(checked) =>
								row.toggleSelected(Boolean(checked))
							}
							onClick={(e) => e.stopPropagation()}
							aria-label="Select task"
							className="cursor-pointer"
						/>
					);
				},
			}),

			// 2. ID / Slug (monospace, like "Q-XXX")
			columnHelper.accessor("slug", {
				header: "ID",
				cell: (info) => {
					if (info.cell.getIsPlaceholder()) return null;
					const isCompleted = isDoneStatus(info.row.original.status.type);
					return (
						<span
							className={cn(
								"text-xs text-muted-foreground shrink-0 font-mono",
								isCompleted && "opacity-60",
							)}
						>
							{info.getValue()}
						</span>
					);
				},
			}),

			// 3. Status icon (clickable dropdown to change status)
			columnHelper.display({
				id: "statusIcon",
				header: "",
				cell: ({ row }) => {
					if (row.getIsGrouped()) return null;
					const taskWithStatus = row.original;
					return <StatusCell taskWithStatus={taskWithStatus} />;
				},
			}),

			// 4. Title (flex, main content)
			columnHelper.accessor("title", {
				header: "Title",
				cell: (info) => {
					if (info.cell.getIsPlaceholder()) return null;
					const isCompleted = isDoneStatus(info.row.original.status.type);
					return (
						<span
							className={cn(
								"text-sm font-medium line-clamp-1",
								isCompleted && "opacity-60 line-through",
							)}
						>
							{info.getValue()}
						</span>
					);
				},
			}),

			// 5. Priority (icon only)
			columnHelper.accessor("priority", {
				header: "Priority",
				cell: (info) => {
					if (info.cell.getIsPlaceholder()) return null;
					return <PriorityCell info={info} />;
				},
			}),

			// 6. Assignee (avatar + name)
			columnHelper.accessor("assigneeId", {
				header: "Assignee",
				filterFn: (row, _columnId, filterValue: string) => {
					if (filterValue === "unassigned") {
						return row.original.assigneeId === null;
					}
					return row.original.assigneeId === filterValue;
				},
				cell: (info) => {
					if (info.cell.getIsPlaceholder()) return null;
					return <AssigneeCell info={info} />;
				},
			}),

			// 7. Labels
			columnHelper.accessor("labels", {
				header: "Labels",
				cell: (info) => {
					if (info.cell.getIsPlaceholder()) return null;
					const labels = info.getValue() || [];
					if (!labels.length) return null;
					return (
						<div className="flex gap-1 shrink-0">
							{labels.slice(0, 2).map((label) => (
								<Badge key={label} variant="outline" className="text-xs">
									{label}
								</Badge>
							))}
							{labels.length > 2 && (
								<Badge variant="outline" className="text-xs">
									+{labels.length - 2}
								</Badge>
							)}
						</div>
					);
				},
			}),

			// 8. Project (color dot + name)
			columnHelper.accessor("externalProvider", {
				header: "Team",
				cell: (info) => {
					if (info.cell.getIsPlaceholder()) return null;
					const name = info.getValue();
					if (!name) return null;
					const color = info.row.original.externalId;
					return (
						<div className="flex items-center gap-1.5 shrink-0">
							<div
								className="w-2 h-2 rounded-full shrink-0"
								style={{ background: color || "#6b6b6b" }}
							/>
							<span className="text-xs text-muted-foreground line-clamp-1">
								{name}
							</span>
						</div>
					);
				},
			}),

			// 9. Due Date (color-coded: red if overdue, amber if within 2 days)
			columnHelper.accessor("dueDate", {
				header: "Due",
				cell: (info) => {
					if (info.cell.getIsPlaceholder()) return null;
					const date = info.getValue();
					if (!date) return null;
					const dueDate = new Date(date);
					const now = new Date();
					const today = startOfDay(now);
					const daysUntilDue = differenceInDays(startOfDay(dueDate), today);
					const isOverdue = isBefore(startOfDay(dueDate), today);
					const isSoon = !isOverdue && daysUntilDue <= 2;

					return (
						<span
							className={cn(
								"text-xs shrink-0",
								isOverdue
									? "text-red-500 font-medium"
									: isSoon
										? "text-amber-500 font-medium"
										: "text-muted-foreground",
							)}
						>
							{format(dueDate, "MMM d")}
						</span>
					);
				},
			}),

			// 10. Modified (relative time)
			columnHelper.accessor("updatedAt", {
				header: "Modified",
				cell: (info) => {
					if (info.cell.getIsPlaceholder()) return null;
					const date = info.getValue();
					if (!date) return null;
					return (
						<span className="text-xs text-muted-foreground shrink-0">
							{formatRelativeTime(new Date(date))}
						</span>
					);
				},
			}),
		],
		[],
	);

	const table = useReactTable({
		data,
		columns,
		state: {
			grouping,
			expanded,
			columnFilters,
			rowSelection,
		},
		getRowId: (row) => row.id,
		enableRowSelection: (row) => !row.getIsGrouped(),
		onRowSelectionChange: setRowSelection,
		onGroupingChange: setGrouping,
		onExpandedChange: setExpanded,
		onColumnFiltersChange: setColumnFilters,
		getCoreRowModel: getCoreRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		getGroupedRowModel: getGroupedRowModel(),
		getExpandedRowModel: getExpandedRowModel(),
		autoResetExpanded: false,
	});

	return { table, isLoading, slugColumnWidth, rowSelection, setRowSelection };
}
