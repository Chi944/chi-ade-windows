import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { toast } from "@superset/ui/sonner";
import { Textarea } from "@superset/ui/textarea";
import { useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { LuCheck, LuClipboard, LuSend } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";

type MessageKind = "handoff" | "decision" | "artifact" | "message";

export function CoordinationView() {
	const { workspaceId } = useParams({ strict: false });
	const utils = electronTrpc.useUtils();
	const queryInput = { workspaceId: workspaceId ?? "" };
	const queryOptions = { enabled: !!workspaceId };
	const { data: peers } = electronTrpc.coordination.peers.useQuery(
		queryInput,
		queryOptions,
	);
	const { data: messages, isLoading } =
		electronTrpc.coordination.inbox.useQuery(queryInput, queryOptions);
	const { data: memories } = electronTrpc.coordination.memories.useQuery(
		queryInput,
		queryOptions,
	);
	const { data: packet } = electronTrpc.coordination.contextPacket.useQuery(
		queryInput,
		queryOptions,
	);

	const [recipientWorkspaceId, setRecipientWorkspaceId] = useState("all");
	const [kind, setKind] = useState<MessageKind>("handoff");
	const [content, setContent] = useState("");
	const [memoryKey, setMemoryKey] = useState("");
	const [memoryContent, setMemoryContent] = useState("");

	const refresh = async () => {
		await Promise.all([
			utils.coordination.inbox.invalidate(),
			utils.coordination.memories.invalidate(),
			utils.coordination.contextPacket.invalidate(),
		]);
	};

	const send = electronTrpc.coordination.send.useMutation({
		onSuccess: async () => {
			setContent("");
			await refresh();
		},
		onError: (error) => toast.error(error.message),
	});
	const acknowledge = electronTrpc.coordination.acknowledge.useMutation({
		onSuccess: refresh,
		onError: (error) => toast.error(error.message),
	});
	const remember = electronTrpc.coordination.upsertMemory.useMutation({
		onSuccess: async () => {
			setMemoryKey("");
			setMemoryContent("");
			await refresh();
		},
		onError: (error) => toast.error(error.message),
	});

	const recipientOptions = useMemo(
		() => peers?.filter((peer) => peer.id !== workspaceId) ?? [],
		[peers, workspaceId],
	);

	if (!workspaceId) {
		return (
			<div className="flex-1 flex items-center justify-center p-4 text-sm text-muted-foreground">
				No agent selected
			</div>
		);
	}

	return (
		<div className="flex flex-1 min-h-0 flex-col overflow-auto p-3 gap-4">
			<section className="space-y-2">
				<div className="text-xs font-medium text-foreground">New handoff</div>
				<div className="grid grid-cols-2 gap-2">
					<select
						aria-label="Recipient agent"
						className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
						value={recipientWorkspaceId}
						onChange={(event) => setRecipientWorkspaceId(event.target.value)}
					>
						<option value="all">All agents</option>
						{recipientOptions.map((peer) => (
							<option key={peer.id} value={peer.id}>
								{peer.name} {peer.runtime ? `(${peer.runtime})` : ""}
							</option>
						))}
					</select>
					<select
						aria-label="Message kind"
						className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
						value={kind}
						onChange={(event) => setKind(event.target.value as MessageKind)}
					>
						<option value="handoff">Handoff</option>
						<option value="decision">Decision</option>
						<option value="artifact">Artifact</option>
						<option value="message">Message</option>
					</select>
				</div>
				<Textarea
					value={content}
					onChange={(event) => setContent(event.target.value)}
					placeholder="Outcome, files changed, tests, blockers, and next step"
					className="min-h-20 resize-y text-xs"
				/>
				<Button
					size="sm"
					className="w-full"
					disabled={!content.trim() || send.isPending}
					onClick={() =>
						send.mutate({
							senderWorkspaceId: workspaceId,
							recipientWorkspaceId:
								recipientWorkspaceId === "all" ? null : recipientWorkspaceId,
							kind,
							content,
						})
					}
				>
					<LuSend className="size-3.5" />
					Send
				</Button>
			</section>

			<section className="rounded-md border border-border/70 bg-tertiary/10 p-2 space-y-2">
				<div className="flex items-center justify-between gap-2">
					<div className="text-xs font-medium">Resume packet</div>
					<span className="text-[10px] text-muted-foreground">
						{packet?.estimatedTokens ?? 0} tokens
						{packet?.estimatedTokensAvoided
							? ` · ~${packet.estimatedTokensAvoided} avoided`
							: ""}
					</span>
				</div>
				<Button
					variant="outline"
					size="sm"
					className="w-full h-7 text-xs"
					disabled={!packet?.content}
					onClick={async () => {
						if (!packet?.content) return;
						await navigator.clipboard.writeText(packet.content);
						toast.success("Context packet copied");
					}}
				>
					<LuClipboard className="size-3.5" />
					Copy bounded context
				</Button>
			</section>

			<section className="space-y-2">
				<div className="flex items-center justify-between">
					<div className="text-xs font-medium">Inbox</div>
					<span className="text-[10px] text-muted-foreground">
						{messages?.length ?? 0} open
					</span>
				</div>
				{isLoading ? (
					<div className="text-xs text-muted-foreground">Loading handoffs…</div>
				) : messages?.length ? (
					messages.map((message) => (
						<div
							key={message.id}
							className="rounded-md border border-border/70 p-2 text-xs space-y-1.5"
						>
							<div className="flex items-center justify-between gap-2">
								<span className="truncate font-medium">
									{message.agentName}
								</span>
								<span className="shrink-0 text-[10px] uppercase text-muted-foreground">
									{message.kind}
								</span>
							</div>
							<div className="whitespace-pre-wrap break-words text-foreground/85">
								{message.content}
							</div>
							<div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
								<span>{new Date(message.createdAt).toLocaleString()}</span>
								<Button
									variant="ghost"
									size="sm"
									className="h-6 px-2 text-[10px]"
									disabled={acknowledge.isPending}
									onClick={() =>
										acknowledge.mutate({
											workspaceId,
											messageId: message.id,
										})
									}
								>
									<LuCheck className="size-3" />
									Done
								</Button>
							</div>
						</div>
					))
				) : (
					<div className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
						No open handoffs
					</div>
				)}
			</section>

			<details className="space-y-2">
				<summary className="cursor-pointer text-xs font-medium">
					Shared memory ({memories?.length ?? 0})
				</summary>
				<div className="pt-2 space-y-2">
					<Input
						value={memoryKey}
						onChange={(event) => setMemoryKey(event.target.value)}
						placeholder="Memory key (for example architecture)"
						className="h-8 text-xs"
					/>
					<Textarea
						value={memoryContent}
						onChange={(event) => setMemoryContent(event.target.value)}
						placeholder="A durable fact or decision, not a raw transcript"
						className="min-h-16 text-xs"
					/>
					<Button
						variant="outline"
						size="sm"
						className="w-full"
						disabled={
							!memoryKey.trim() || !memoryContent.trim() || remember.isPending
						}
						onClick={() =>
							remember.mutate({
								workspaceId,
								scope: "project",
								key: memoryKey,
								title: memoryKey,
								content: memoryContent,
							})
						}
					>
						Save project memory
					</Button>
					{memories?.map((memory) => (
						<div
							key={memory.id}
							className="rounded border border-border/60 p-2 text-xs"
						>
							<div className="font-medium">{memory.title}</div>
							<div className="mt-1 text-muted-foreground whitespace-pre-wrap">
								{memory.summary || memory.content}
							</div>
						</div>
					))}
				</div>
			</details>
		</div>
	);
}
