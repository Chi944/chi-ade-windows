import { create } from "zustand";
import { devtools } from "zustand/middleware";

interface NewCategoryModalState {
	isOpen: boolean;
	openModal: () => void;
	closeModal: () => void;
}

export const useNewCategoryModalStore = create<NewCategoryModalState>()(
	devtools(
		(set) => ({
			isOpen: false,
			openModal: () => set({ isOpen: true }),
			closeModal: () => set({ isOpen: false }),
		}),
		{ name: "NewCategoryModalStore" },
	),
);

export const useNewCategoryModalOpen = () =>
	useNewCategoryModalStore((s) => s.isOpen);
export const useOpenNewCategoryModal = () =>
	useNewCategoryModalStore((s) => s.openModal);
export const useCloseNewCategoryModal = () =>
	useNewCategoryModalStore((s) => s.closeModal);
