# Remote work

ADE 0.4 uses the OpenSSH client already supplied by Windows or macOS. It adds no SSH library, credential database, or bundled model runtime.

## Remote Runtime v1

- Save host, user, port, optional identity-file path, remote root, and an explicit agent-forwarding preference.
- Choose **Trust & test** to add a previously unseen host key and verify the connection. Changed host keys still fail. Managed terminals and tunnels always require an existing matching key.
- Bind any ADE workspace to a saved host and an optional remote path from **Settings â†’ Terminal**.
- Launch every terminal pane in that workspace as a direct OpenSSH PTY using an exact main-process-generated executable and argument list.
- Keep terminal panes alive in ADE's detached service when the app closes. A stable per-pane `tmux` session also preserves the remote process across SSH reconnects when `tmux` is installed on the host.
- Retry an interactive SSH connection up to five times with exponential backoff after OpenSSH reports a network disconnect.
- Configure up to 16 local or remote port forwards per workspace. ADE runs them once in a hidden managed tunnel so split panes never compete for the same listen port.
- Restart enabled tunnels automatically while ADE is open and reconcile them after the app restarts.
- Generate a safely quoted remote `git worktree add` command through the local remote router.

Forward listeners are fixed to `127.0.0.1` in v1. Listen ports must be `1024â€“65535`; destinations must be `1â€“65535`. Duplicate directions and listen ports are rejected, as are conflicts with enabled tunnels. Tunnel startup uses `ExitOnForwardFailure=yes`.

## Security boundary

ADE stores connection metadata only. Passwords, private keys, host keys, and SSH-agent material remain under the operating system's control. SSH launches use the fixed system executable (`System32\\OpenSSH\\ssh.exe` or `/usr/bin/ssh`), strict host-key checking, disabled X11 and local commands, keepalives, and a minimal environment. Provider API keys, coordination tokens, and subscription account homes are not passed to SSH.

Agent forwarding remains off by default because a trusted remote process can use the forwarded agent while a connection is active. Tunnel processes never receive agent forwarding.

Changing a workspace binding does not terminate an existing local task. Close or stop its existing terminal panes before reopening them on the new transport. Remote Runtime v1 targets POSIX SSH hosts; `tmux` is optional, but without it a network reconnect starts a fresh remote shell.

## Build order from here

1. Add confined remote filesystem reads and atomic SFTP writes with offline/reconnect handling.
2. Add remote Git status, diffs, and worktree lifecycle.
3. Add drag/drop transfer with size limits, checksums, and confirmation.
4. Extend file links, Design Mode, and diff annotations to remote paths.

Until those steps land, ADE file browsing, diffs, Design Mode, and drag/drop operate on local files even when the terminal transport is remote.
