import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import { toast } from "@superset/ui/sonner";
import { useState } from "react";
import { HiOutlinePaintBrush } from "react-icons/hi2";
import { useSetTheme, useThemeStore } from "renderer/stores";
import {
	createCustomizedTheme,
	type EssentialThemeColors,
	getContrastRatio,
	getEssentialThemeColors,
	type Theme,
} from "shared/themes";

const COLOR_FIELDS: Array<{
	key: keyof EssentialThemeColors;
	label: string;
	description: string;
}> = [
	{ key: "background", label: "Background", description: "App canvas" },
	{ key: "surface", label: "Surface", description: "Cards and panels" },
	{ key: "foreground", label: "Text", description: "UI and terminal text" },
	{ key: "primary", label: "Accent", description: "Actions and focus" },
	{ key: "border", label: "Border", description: "Dividers and inputs" },
	{
		key: "terminalBackground",
		label: "Terminal",
		description: "Terminal background",
	},
];

interface ThemeColorEditorProps {
	baseTheme: Theme;
}

export function ThemeColorEditor({ baseTheme }: ThemeColorEditorProps) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [colors, setColors] = useState<EssentialThemeColors>(() =>
		getEssentialThemeColors(baseTheme),
	);
	const upsertCustomThemes = useThemeStore((state) => state.upsertCustomThemes);
	const setTheme = useSetTheme();

	const handleOpen = () => {
		setName(baseTheme.isCustom ? baseTheme.name : `${baseTheme.name} Custom`);
		setColors(getEssentialThemeColors(baseTheme));
		setOpen(true);
	};

	const handleSave = () => {
		const trimmedName = name.trim();
		if (!trimmedName) return;

		const customizedTheme = createCustomizedTheme(baseTheme, {
			id: baseTheme.isCustom
				? baseTheme.id
				: `custom-${Date.now().toString(36)}`,
			name: trimmedName,
			colors,
		});
		const summary = upsertCustomThemes([customizedTheme]);
		if (summary.added + summary.updated === 0) {
			toast.error("Could not save this theme");
			return;
		}

		setTheme(customizedTheme.id);
		setOpen(false);
		toast.success("Custom theme saved and applied");
	};

	const previewTheme = createCustomizedTheme(baseTheme, {
		id: "preview",
		name: name || "Preview",
		colors,
	});
	const interfaceContrast = getContrastRatio(
		colors.foreground,
		colors.background,
	);
	const terminalContrast = getContrastRatio(
		colors.foreground,
		colors.terminalBackground,
	);
	const contrastPasses = interfaceContrast >= 4.5 && terminalContrast >= 4.5;

	return (
		<>
			<Button type="button" variant="secondary" size="sm" onClick={handleOpen}>
				<HiOutlinePaintBrush className="mr-1.5 h-4 w-4" />
				Customize Colours
			</Button>

			<Dialog modal open={open} onOpenChange={setOpen}>
				<DialogContent className="sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>Customize theme colours</DialogTitle>
						<DialogDescription>
							Start from {baseTheme.name} and adjust the essential palette. ADE
							keeps related interface and terminal colours in sync.
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-4 py-2">
						<div className="space-y-2">
							<Label htmlFor="custom-theme-name">Theme name</Label>
							<Input
								id="custom-theme-name"
								value={name}
								onChange={(event) => setName(event.target.value)}
								placeholder="My theme"
							/>
						</div>

						<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
							{COLOR_FIELDS.map((field) => (
								<div
									key={field.key}
									className="flex items-center gap-3 rounded-lg border bg-card p-3"
								>
									<input
										id={`theme-color-${field.key}`}
										type="color"
										value={colors[field.key]}
										onChange={(event) =>
											setColors((current) => ({
												...current,
												[field.key]: event.target.value,
											}))
										}
										className="h-10 w-12 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-1"
										aria-label={`${field.label} colour`}
									/>
									<div className="min-w-0">
										<Label htmlFor={`theme-color-${field.key}`}>
											{field.label}
										</Label>
										<p className="mt-1 truncate text-xs text-muted-foreground">
											{field.description}
										</p>
										<code className="mt-1 block text-[11px] uppercase text-muted-foreground">
											{colors[field.key]}
										</code>
									</div>
								</div>
							))}
						</div>

						<div
							className="overflow-hidden rounded-lg border p-3"
							style={{
								backgroundColor: previewTheme.ui.background,
								borderColor: previewTheme.ui.border,
								color: previewTheme.ui.foreground,
							}}
						>
							<div className="flex items-center justify-between gap-3">
								<div>
									<p className="text-sm font-medium">Live preview</p>
									<p className="text-xs opacity-70">
										Interface and terminal palette
									</p>
								</div>
								<span
									className="rounded-md px-3 py-1.5 text-xs font-medium"
									style={{
										backgroundColor: previewTheme.ui.primary,
										color: previewTheme.ui.primaryForeground,
									}}
								>
									Primary action
								</span>
							</div>
							<div
								className="mt-3 rounded-md px-3 py-2 font-mono text-xs"
								style={{
									backgroundColor: previewTheme.terminal?.background,
									color: previewTheme.terminal?.foreground,
								}}
							>
								<span style={{ color: previewTheme.terminal?.cursor }}>$</span>{" "}
								ADE is ready
							</div>
						</div>

						<p
							className={
								contrastPasses
									? "text-xs text-muted-foreground"
									: "text-xs text-destructive"
							}
							role={contrastPasses ? undefined : "alert"}
						>
							Text contrast: interface {interfaceContrast.toFixed(1)}:1,
							terminal {terminalContrast.toFixed(1)}:1. Both must be at least
							4.5:1 before applying.
						</p>
					</div>

					<DialogFooter>
						<Button
							variant="ghost"
							onClick={() => setColors(getEssentialThemeColors(baseTheme))}
						>
							Reset palette
						</Button>
						<Button variant="outline" onClick={() => setOpen(false)}>
							Cancel
						</Button>
						<Button
							onClick={handleSave}
							disabled={!name.trim() || !contrastPasses}
						>
							Save & Apply
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
