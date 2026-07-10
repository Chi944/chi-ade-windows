import { Badge } from "@superset/ui/badge";
import { Button } from "@superset/ui/button";
import { Card, CardContent, CardHeader } from "@superset/ui/card";
import { toast } from "@superset/ui/sonner";
import { LuFolderOpen, LuRefreshCw, LuTerminal } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";

export function LocalExtensionsSection() {
	const utils = electronTrpc.useUtils();
	const { data, isLoading } = electronTrpc.extensions.list.useQuery();
	const openDirectory = electronTrpc.extensions.openDirectory.useMutation({
		onError: (error) => toast.error(error.message),
		onSuccess: (result) => {
			if (!result.success)
				toast.error(result.error || "Could not open extensions folder");
		},
	});
	const createPreset = electronTrpc.settings.createTerminalPreset.useMutation({
		onSuccess: async () => {
			await utils.settings.getTerminalPresets.invalidate();
			toast.success("Agent command added to the Agent Bar");
		},
		onError: (error) => toast.error(error.message),
	});

	return (
		<section className="mb-8 space-y-3">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h3 className="text-base font-semibold">Local extension registry</h3>
					<p className="text-xs text-muted-foreground mt-1 max-w-2xl">
						Declarative manifests can contribute terminal agents, skills, and
						MCP connectors. ADE never executes an extension until you explicitly
						add or run its command.
					</p>
				</div>
				<div className="flex gap-2 shrink-0">
					<Button
						variant="outline"
						size="sm"
						onClick={() => utils.extensions.list.invalidate()}
					>
						<LuRefreshCw className="size-3.5" />
						Rescan
					</Button>
					<Button
						variant="outline"
						size="sm"
						onClick={() => openDirectory.mutate()}
					>
						<LuFolderOpen className="size-3.5" />
						Open folder
					</Button>
				</div>
			</div>

			<div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 font-mono text-[11px] text-muted-foreground break-all">
				{data?.directory || "~/.ade/extensions"}
				/&lt;extension&gt;/ade-extension.json
			</div>

			{isLoading ? (
				<div className="text-xs text-muted-foreground">
					Scanning extensions…
				</div>
			) : data?.entries.length ? (
				<div className="grid gap-3">
					{data.entries.map((entry) =>
						entry.status === "invalid" ? (
							<Card key={entry.directory} className="border-destructive/40">
								<CardHeader className="pb-2">
									<div className="flex items-center justify-between">
										<span className="font-medium">Invalid extension</span>
										<Badge variant="destructive">Blocked</Badge>
									</div>
								</CardHeader>
								<CardContent className="text-xs text-muted-foreground">
									{entry.error}
								</CardContent>
							</Card>
						) : (
							<Card key={entry.manifest.id}>
								<CardHeader className="pb-2">
									<div className="flex items-center justify-between gap-2">
										<div>
											<span className="font-medium">{entry.manifest.name}</span>
											<span className="ml-2 text-xs text-muted-foreground">
												v{entry.manifest.version}
											</span>
										</div>
										<Badge variant={entry.compatible ? "secondary" : "outline"}>
											{entry.compatible ? "Compatible" : "Other platform"}
										</Badge>
									</div>
									{entry.manifest.description && (
										<p className="text-xs text-muted-foreground">
											{entry.manifest.description}
										</p>
									)}
								</CardHeader>
								<CardContent className="space-y-3">
									<div className="flex flex-wrap gap-1.5 text-[11px]">
										<Badge variant="outline">
											{entry.manifest.agents.length} agents
										</Badge>
										<Badge variant="outline">
											{entry.manifest.skills.length} skills
										</Badge>
										<Badge variant="outline">
											{entry.manifest.mcpServers.length} MCP
										</Badge>
										{entry.manifest.permissions.map((permission) => (
											<Badge key={permission} variant="outline">
												{permission}
											</Badge>
										))}
									</div>
									{entry.manifest.agents.map((agent) => (
										<div
											key={agent.id}
											className="flex items-center justify-between gap-3 rounded border border-border/60 p-2"
										>
											<div className="min-w-0">
												<div className="text-sm font-medium">{agent.name}</div>
												<code className="block truncate text-[11px] text-muted-foreground">
													{agent.command}
												</code>
											</div>
											<Button
												variant="outline"
												size="sm"
												disabled={!entry.compatible || createPreset.isPending}
												onClick={() =>
													createPreset.mutate({
														name: agent.name,
														description:
															agent.description ||
															`From ${entry.manifest.name}`,
														cwd: agent.cwd || "",
														commands: [agent.command],
														pinnedToBar: true,
													})
												}
											>
												<LuTerminal className="size-3.5" />
												Add agent
											</Button>
										</div>
									))}
								</CardContent>
							</Card>
						),
					)}
				</div>
			) : (
				<div className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground">
					No local extensions installed. Open the folder to add a versioned
					manifest.
				</div>
			)}
		</section>
	);
}
