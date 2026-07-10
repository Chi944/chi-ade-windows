# Remote work

ADE 0.4 uses the OpenSSH client already supplied by Windows or macOS. It adds no SSH library, credential database, or bundled model runtime.

## Remote Runtime v1

- Save host, user, port, optional identity-file path, remote root, and an explicit agent-forwarding preference.
- Choose **Trust & test** to add a previously unseen host key and verify the connection. Changed host keys still fail. Managed terminals and tunnels always require an existing matching key.
- Bind any ADE workspace to a saved host and an optional remote path from **Settings > Terminal**.
- Launch every terminal pane in that workspace as a direct OpenSSH PTY using an exact main-process-generated executable and argument list.
- Keep terminal panes alive in ADE's detached service when the app closes. A stable per-pane `tmux` session also preserves the remote process across SSH reconnects when `tmux` is installed on the host.
- Retry an interactive SSH connection up to five times with exponential backoff after OpenSSH reports a network disconnect.
- Configure up to 16 local or remote port forwards per workspace. ADE runs them once in a hidden managed tunnel so split panes never compete for the same listen port.
- Restart enabled tunnels automatically while ADE is open and reconcile them after the app restarts.
- Create a Git worktree on the SSH host from **Settings > Terminal**. ADE executes Git through fixed OpenSSH arguments and changes the workspace binding only after Git succeeds.

Forward listeners are fixed to `127.0.0.1` in v1. Listen ports must be `1024-65535`; destinations must be `1-65535`. Duplicate directions and listen ports are rejected, as are conflicts with enabled tunnels. Tunnel startup uses `ExitOnForwardFailure=yes`.

## Remote Filesystem/SFTP v1

When a workspace is bound to SSH, its Files sidebar switches to the configured remote root automatically. The first release supports:

- bounded directory browsing, including hidden files;
- creating files and folders, renaming, file deletion, and empty-folder deletion;
- text and Markdown editing with SHA-256 revision checks, so a concurrent change is reported instead of overwritten;
- image previews up to the existing preview limit;
- collision-safe multi-file uploads from the picker or by dropping operating-system files onto the explorer;
- file and directory downloads through native save/folder dialogs; and
- SSH worktree creation followed by an automatic switch to the new remote path.

Directory metadata is read through the same strict SSH account using a fixed POSIX script with NUL-delimited records. File bytes always travel through the operating system's SFTP client (`System32\\OpenSSH\\sftp.exe` on Windows or `/usr/bin/sftp` on macOS). Editor saves upload to a random sibling, acquire a per-file remote lock, verify the expected SHA-256 revision, atomically replace the file, and restore its POSIX mode. Temporary local files are removed immediately. General uploads also stage to sibling files and reject existing names instead of overwriting them.

The configured SSH account remains the access boundary. Renderer calls contain only a workspace ID and root-relative path; the main process resolves the host and root, rejects traversal and control characters, disables forwarding for transfers, and never invokes a local shell. Remote symlinks are shown as files and are not followed as directories in this version.

## Security boundary

ADE stores connection metadata only. Passwords, private keys, host keys, and SSH-agent material remain under the operating system's control. SSH launches use the fixed system executable (`System32\\OpenSSH\\ssh.exe` or `/usr/bin/ssh`), strict host-key checking, disabled X11 and local commands, keepalives, and a minimal environment. Provider API keys, coordination tokens, and subscription account homes are not passed to SSH.

Agent forwarding remains off by default because a trusted remote process can use the forwarded agent while a connection is active. Tunnel and SFTP processes never receive agent forwarding.

Changing a workspace binding does not terminate an existing local task. Close or stop its existing terminal panes before reopening them on the new transport. Remote Runtime v1 targets POSIX SSH hosts; `tmux` is optional, but without it a network reconnect starts a fresh remote shell.

## Build order from here

1. Add remote Git status, diff rendering, staging, and the remaining worktree lifecycle actions.
2. Add resumable background transfers with progress, cancellation, and reconnect queues.
3. Extend file links, Design Mode, and AI diff annotations to remote paths.
4. Add opt-in remote indexing and search with explicit resource limits.

Remote search, Git diffs, Design Mode, and diff annotations remain local-only in this version.
