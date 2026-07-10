import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import { toast } from "@superset/ui/sonner";
import { useState } from "react";
import { LuClipboard, LuPlugZap, LuTrash2 } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";

export function RemoteHostsSection() {
	const utils = electronTrpc.useUtils();
	const { data: hosts } = electronTrpc.remote.list.useQuery();
	const [name, setName] = useState("");
	const [host, setHost] = useState("");
	const [user, setUser] = useState("");
	const [port, setPort] = useState("22");
	const [identityFile, setIdentityFile] = useState("");
	const [remoteRoot, setRemoteRoot] = useState("");
	const [agentForwarding, setAgentForwarding] = useState(false);

	const upsert = electronTrpc.remote.upsert.useMutation({
		onSuccess: async () => {
			setName("");
			setHost("");
			setUser("");
			setPort("22");
			setIdentityFile("");
			setRemoteRoot("");
			setAgentForwarding(false);
			await utils.remote.list.invalidate();
			toast.success("Remote host saved");
		},
		onError: (error) => toast.error(error.message),
	});
	const remove = electronTrpc.remote.remove.useMutation({
		onSuccess: () => utils.remote.list.invalidate(),
		onError: (error) => toast.error(error.message),
	});
	const test = electronTrpc.remote.test.useMutation({
		onSuccess: (result) => {
			if (result.ok) {
				toast.success(`SSH connected in ${result.latencyMs} ms`);
			} else {
				toast.error("SSH connection failed", { description: result.error });
			}
		},
		onError: (error) => toast.error(error.message),
	});

	return (
		<div className="space-y-4">
			<div className="space-y-0.5">
				<Label className="text-sm font-medium">Remote OpenSSH hosts</Label>
				<p className="text-xs text-muted-foreground max-w-3xl">
					Use the OpenSSH client and credentials already managed by Windows or
					macOS. ADE stores connection metadata only—never passwords or private
					keys.
				</p>
			</div>

			{hosts?.length ? (
				<div className="grid gap-2">
					{hosts.map((saved) => (
						<div
							key={saved.id}
							className="flex items-center justify-between gap-3 rounded-md border border-border/60 p-3"
						>
							<div className="min-w-0">
								<div className="text-sm font-medium truncate">{saved.name}</div>
								<div className="text-xs text-muted-foreground font-mono truncate">
									{saved.user ? `${saved.user}@` : ""}
									{saved.host}:{saved.port}
									{saved.remoteRoot ? ` · ${saved.remoteRoot}` : ""}
								</div>
							</div>
							<div className="flex shrink-0 items-center gap-1">
								<Button
									variant="outline"
									size="sm"
									disabled={test.isPending}
									onClick={() => test.mutate({ id: saved.id })}
								>
									<LuPlugZap className="size-3.5" />
									Test
								</Button>
								<Button
									variant="outline"
									size="sm"
									onClick={async () => {
										const result = await utils.remote.terminalCommand.fetch({
											id: saved.id,
										});
										await navigator.clipboard.writeText(result.command);
										toast.success("SSH command copied");
									}}
								>
									<LuClipboard className="size-3.5" />
									Copy
								</Button>
								<Button
									variant="ghost"
									size="icon"
									className="size-8"
									disabled={remove.isPending}
									onClick={() => remove.mutate({ id: saved.id })}
									aria-label={`Remove ${saved.name}`}
								>
									<LuTrash2 className="size-3.5" />
								</Button>
							</div>
						</div>
					))}
				</div>
			) : (
				<div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
					No remote hosts saved.
				</div>
			)}

			<details className="rounded-md border border-border/60 p-3">
				<summary className="cursor-pointer text-sm font-medium">
					Add remote host
				</summary>
				<div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-4">
					<div className="space-y-1">
						<Label htmlFor="remote-name">Name</Label>
						<Input
							id="remote-name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder="Build Mac"
						/>
					</div>
					<div className="space-y-1">
						<Label htmlFor="remote-host">Host</Label>
						<Input
							id="remote-host"
							value={host}
							onChange={(event) => setHost(event.target.value)}
							placeholder="build.example.com"
						/>
					</div>
					<div className="space-y-1">
						<Label htmlFor="remote-user">User</Label>
						<Input
							id="remote-user"
							value={user}
							onChange={(event) => setUser(event.target.value)}
							placeholder="chi"
						/>
					</div>
					<div className="space-y-1">
						<Label htmlFor="remote-port">Port</Label>
						<Input
							id="remote-port"
							type="number"
							min={1}
							max={65_535}
							value={port}
							onChange={(event) => setPort(event.target.value)}
						/>
					</div>
					<div className="space-y-1">
						<Label htmlFor="remote-identity">Identity file (optional)</Label>
						<Input
							id="remote-identity"
							value={identityFile}
							onChange={(event) => setIdentityFile(event.target.value)}
							placeholder="~/.ssh/id_ed25519"
						/>
					</div>
					<div className="space-y-1">
						<Label htmlFor="remote-root">Remote workspace root</Label>
						<Input
							id="remote-root"
							value={remoteRoot}
							onChange={(event) => setRemoteRoot(event.target.value)}
							placeholder="~/worktrees"
						/>
					</div>
					<label className="md:col-span-2 flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={agentForwarding}
							onChange={(event) => setAgentForwarding(event.target.checked)}
						/>
						Forward the local SSH agent for this connection
					</label>
					<div className="md:col-span-2 flex justify-end">
						<Button
							disabled={!name.trim() || !host.trim() || upsert.isPending}
							onClick={() =>
								upsert.mutate({
									name,
									host,
									user: user || undefined,
									port: Number.parseInt(port, 10) || 22,
									identityFile: identityFile || undefined,
									remoteRoot: remoteRoot || undefined,
									agentForwarding,
								})
							}
						>
							Save host
						</Button>
					</div>
				</div>
			</details>
		</div>
	);
}
