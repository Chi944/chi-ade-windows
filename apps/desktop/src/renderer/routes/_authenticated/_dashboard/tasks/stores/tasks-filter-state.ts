import { create } from "zustand";

interface TasksFilterState {
	tab: "all" | "active" | "backlog";
	assignee: string | null;
	search: string;
	projectFilter: string[];
	availableProjects: string[];
	setTab: (tab: "all" | "active" | "backlog") => void;
	setAssignee: (assignee: string | null) => void;
	setSearch: (search: string) => void;
	setProjectFilter: (filter: string[]) => void;
	setAvailableProjects: (projects: string[]) => void;
}

export const useTasksFilterStore = create<TasksFilterState>()((set) => ({
	tab: "all",
	assignee: null,
	search: "",
	projectFilter: [],
	availableProjects: [],
	setTab: (tab) => set({ tab }),
	setAssignee: (assignee) => set({ assignee }),
	setSearch: (search) => set({ search }),
	setProjectFilter: (projectFilter) => set({ projectFilter }),
	setAvailableProjects: (availableProjects) => set({ availableProjects }),
}));
