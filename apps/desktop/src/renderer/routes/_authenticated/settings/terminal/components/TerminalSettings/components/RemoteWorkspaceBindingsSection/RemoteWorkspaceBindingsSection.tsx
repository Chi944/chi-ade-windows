import type {
	SelectRemoteHost,
	SelectRemoteWorkspaceBinding,
	SelectWorkspace,
} from "@superset/local-db";
import { Label } from "@superset/ui/label";
import { useEffect, useMemo, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { RemoteWorkspaceBindingRow } from "./RemoteWorkspaceBindingRow";

export interface TunnelStatus {
	workspaceId: string;
	state: "stopped" | "connecting" | "connected" | "retrying" | "error";
	updatedAt: number;
	error?: string;
}

export function RemoteWorkspaceBindingsSection() {
	const { data: hosts } = electronTrpc.remote.list.useQuery();
	const { data: bindings } = electronTrpc.remote.bindings.useQuery();
	const { data: workspaces } = electronTrpc.workspaces.getAll.useQuery();
	const { data: initialStatuses } =
		electronTrpc.remote.tunnelStatuses.useQuery();
	const [liveStatuses, setLiveStatuses] = useState<
		Record<string, TunnelStatus>
	>({});

	useEffect(() => {
		if (!initialStatuses) return;
		setLiveStatuses(
			Object.fromEntries(
				initialStatuses.map((status) => [status.workspaceId, status]),
			),
		);
	}, [initialStatuses]);

	electronTrpc.remote.tunnelStatus.useSubscription(undefined, {
		onData: (status) => {
			setLiveStatuses((current) => ({
				...current,
				[status.workspaceId]: status,
			}));
		},
	});

	const bindingByWorkspace = useMemo(
		() =>
			new Map(
				(bindings ?? []).map((binding) => [binding.workspaceId, binding]),
			),
		[bindings],
	);

	return (
		<div className="space-y-4">
			<div className="space-y-0.5">
				<Label className="text-sm font-medium">Remote workspace runtime</Label>
				<p className="max-w-3xl text-xs text-muted-foreground">
					Bind a workspace to a saved host. Every terminal in that workspace
					uses a durable SSH PTY, while port forwards run once in a separate
					managed tunnel so split terminals never compete for the same port.
				</p>
			</div>

			{!hosts?.length ? (
				<div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
					Save and trust an SSH host before binding a workspace.
				</div>
			) : workspaces?.length ? (
				<div className="grid gap-3">
					{workspaces.map((workspace) => (
						<RemoteWorkspaceBindingRow
							key={workspace.id}
							workspace={workspace as SelectWorkspace}
							hosts={hosts as SelectRemoteHost[]}
							binding={
								bindingByWorkspace.get(workspace.id) as
									| SelectRemoteWorkspaceBinding
									| undefined
							}
							status={liveStatuses[workspace.id]}
						/>
					))}
				</div>
			) : (
				<div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
					Create a workspace before configuring a remote runtime.
				</div>
			)}
		</div>
	);
}
