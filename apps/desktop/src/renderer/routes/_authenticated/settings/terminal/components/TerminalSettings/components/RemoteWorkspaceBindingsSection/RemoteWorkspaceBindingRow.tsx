import type {
	RemotePortForward,
	SelectRemoteHost,
	SelectRemoteWorkspaceBinding,
	SelectWorkspace,
} from "@superset/local-db";
import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { toast } from "@superset/ui/sonner";
import { useEffect, useState } from "react";
import { LuCable, LuPlus, LuSave, LuSquare, LuTrash2 } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import type { TunnelStatus } from "./RemoteWorkspaceBindingsSection";

interface RemoteWorkspaceBindingRowProps {
	workspace: SelectWorkspace;
	hosts: SelectRemoteHost[];
	binding?: SelectRemoteWorkspaceBinding;
	status?: TunnelStatus;
}

const statusStyle: Record<TunnelStatus["state"], string> = {
	stopped: "bg-muted text-muted-foreground",
	connecting: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
	connected: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
	retrying: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
	error: "bg-destructive/15 text-destructive",
};

function newForward(): RemotePortForward {
	return {
		id: crypto.randomUUID(),
		direction: "local",
		listenPort: 3000,
		targetHost: "127.0.0.1",
		targetPort: 3000,
	};
}

export function RemoteWorkspaceBindingRow({
	workspace,
	hosts,
	binding,
	status,
}: RemoteWorkspaceBindingRowProps) {
	const utils = electronTrpc.useUtils();
	const [remoteHostId, setRemoteHostId] = useState(binding?.remoteHostId ?? "");
	const [remotePath, setRemotePath] = useState(binding?.remotePath ?? "");
	const [portForwards, setPortForwards] = useState<RemotePortForward[]>(
		binding?.portForwards ?? [],
	);
	const [expanded, setExpanded] = useState(!!binding);

	useEffect(() => {
		setRemoteHostId(binding?.remoteHostId ?? "");
		setRemotePath(binding?.remotePath ?? "");
		setPortForwards(binding?.portForwards ?? []);
		setExpanded(!!binding);
	}, [binding]);

	const refresh = async () => {
		await Promise.all([
			utils.remote.bindings.invalidate(),
			utils.remote.binding.invalidate({ workspaceId: workspace.id }),
			utils.remote.tunnelStatuses.invalidate(),
		]);
	};
	const bind = electronTrpc.remote.bindWorkspace.useMutation({
		onSuccess: async () => {
			await refresh();
			toast.success(`${workspace.name} now uses the selected SSH host`);
		},
		onError: (error) => toast.error(error.message),
	});
	const unbind = electronTrpc.remote.unbindWorkspace.useMutation({
		onSuccess: async () => {
			await refresh();
			toast.success(`${workspace.name} now uses the local runtime`);
		},
		onError: (error) => toast.error(error.message),
	});
	const startTunnel = electronTrpc.remote.startTunnel.useMutation({
		onSuccess: refresh,
		onError: (error) => toast.error(error.message),
	});
	const stopTunnel = electronTrpc.remote.stopTunnel.useMutation({
		onSuccess: refresh,
		onError: (error) => toast.error(error.message),
	});

	const currentStatus = status?.state ?? "stopped";
	const hasUnsavedChanges =
		remoteHostId !== (binding?.remoteHostId ?? "") ||
		remotePath !== (binding?.remotePath ?? "") ||
		JSON.stringify(portForwards) !==
			JSON.stringify(binding?.portForwards ?? []);
	const busy =
		bind.isPending ||
		unbind.isPending ||
		startTunnel.isPending ||
		stopTunnel.isPending;
	const save = () => {
		if (!remoteHostId) return;
		bind.mutate({
			workspaceId: workspace.id,
			remoteHostId,
			remotePath: remotePath || undefined,
			portForwards,
		});
	};
	const updateForward = (id: string, patch: Partial<RemotePortForward>) => {
		setPortForwards((current) =>
			current.map((forward) =>
				forward.id === id ? { ...forward, ...patch } : forward,
			),
		);
	};

	return (
		<details
			className="rounded-md border border-border/60 p-3"
			open={expanded}
			onToggle={(event) => setExpanded(event.currentTarget.open)}
		>
			<summary className="cursor-pointer list-none">
				<div className="flex items-center justify-between gap-3">
					<div className="min-w-0">
						<div className="truncate text-sm font-medium">{workspace.name}</div>
						<div className="truncate font-mono text-xs text-muted-foreground">
							{workspace.branch}
						</div>
					</div>
					<span
						className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${statusStyle[currentStatus]}`}
					>
						{binding ? currentStatus : "local"}
					</span>
				</div>
			</summary>

			<div className="space-y-4 pt-4">
				<div className="grid gap-3 md:grid-cols-2">
					<div className="space-y-1">
						<Label>SSH host</Label>
						<Select value={remoteHostId} onValueChange={setRemoteHostId}>
							<SelectTrigger>
								<SelectValue placeholder="Choose a saved host" />
							</SelectTrigger>
							<SelectContent>
								{hosts.map((host) => (
									<SelectItem key={host.id} value={host.id}>
										{host.name} ({host.host})
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="space-y-1">
						<Label htmlFor={`remote-path-${workspace.id}`}>Remote path</Label>
						<Input
							id={`remote-path-${workspace.id}`}
							value={remotePath}
							onChange={(event) => setRemotePath(event.target.value)}
							placeholder="/srv/worktrees/project"
						/>
					</div>
				</div>

				<div className="space-y-2">
					<div className="flex items-center justify-between gap-2">
						<div>
							<Label>Loopback port forwards</Label>
							<p className="text-xs text-muted-foreground">
								Local exposes a remote service on this computer. Remote exposes
								a service from this computer on the SSH host.
							</p>
						</div>
						<Button
							variant="outline"
							size="sm"
							disabled={portForwards.length >= 16}
							onClick={() =>
								setPortForwards((current) => [...current, newForward()])
							}
						>
							<LuPlus className="size-3.5" />
							Add forward
						</Button>
					</div>

					{portForwards.map((forward) => (
						<div
							key={forward.id}
							className="grid gap-2 rounded-md border border-border/60 p-2 md:grid-cols-[130px_110px_1fr_110px_36px]"
						>
							<Select
								value={forward.direction}
								onValueChange={(value: "local" | "remote") =>
									updateForward(forward.id, { direction: value })
								}
							>
								<SelectTrigger aria-label="Forward direction">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="local">Local</SelectItem>
									<SelectItem value="remote">Remote</SelectItem>
								</SelectContent>
							</Select>
							<Input
								type="number"
								min={1024}
								max={65_535}
								value={forward.listenPort}
								onChange={(event) =>
									updateForward(forward.id, {
										listenPort: Number(event.target.value),
									})
								}
								aria-label="Listen port"
							/>
							<Input
								value={forward.targetHost}
								onChange={(event) =>
									updateForward(forward.id, {
										targetHost: event.target.value,
									})
								}
								placeholder="127.0.0.1"
								aria-label="Destination host"
							/>
							<Input
								type="number"
								min={1}
								max={65_535}
								value={forward.targetPort}
								onChange={(event) =>
									updateForward(forward.id, {
										targetPort: Number(event.target.value),
									})
								}
								aria-label="Destination port"
							/>
							<Button
								variant="ghost"
								size="icon"
								onClick={() =>
									setPortForwards((current) =>
										current.filter((item) => item.id !== forward.id),
									)
								}
								aria-label="Remove forward"
							>
								<LuTrash2 className="size-3.5" />
							</Button>
						</div>
					))}
				</div>

				{status?.error && (
					<p className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
						{status.error}
					</p>
				)}

				<div className="flex flex-wrap justify-end gap-2">
					{binding && (
						<Button
							variant="ghost"
							disabled={busy}
							onClick={() => unbind.mutate({ workspaceId: workspace.id })}
						>
							<LuTrash2 className="size-3.5" />
							Use local runtime
						</Button>
					)}
					<Button
						variant="outline"
						disabled={
							busy || !binding || portForwards.length === 0 || hasUnsavedChanges
						}
						title={hasUnsavedChanges ? "Save runtime changes first" : undefined}
						onClick={() =>
							currentStatus === "connected" || currentStatus === "retrying"
								? stopTunnel.mutate({ workspaceId: workspace.id })
								: startTunnel.mutate({ workspaceId: workspace.id })
						}
					>
						{currentStatus === "connected" || currentStatus === "retrying" ? (
							<LuSquare className="size-3.5" />
						) : (
							<LuCable className="size-3.5" />
						)}
						{currentStatus === "connected" || currentStatus === "retrying"
							? "Stop tunnel"
							: "Start tunnel"}
					</Button>
					<Button disabled={busy || !remoteHostId} onClick={save}>
						<LuSave className="size-3.5" />
						Save runtime
					</Button>
				</div>
			</div>
		</details>
	);
}
