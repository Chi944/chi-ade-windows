# Remote work

ADE 0.4 begins the remote-runtime build order with a storage-conscious OpenSSH layer.

## Available now

- Save host, user, port, optional identity-file path, remote root, and agent-forwarding preference.
- Test a connection using `BatchMode=yes`, a seven-second connection timeout, and changed-host protection through OpenSSH.
- Copy a correctly quoted SSH command for an ADE terminal.
- Generate a safely quoted remote `git worktree add` command through the local remote router.
- Use the OpenSSH client, agent, keychain/credential integration, and `known_hosts` already supplied by Windows or macOS.

ADE stores connection metadata only. It does not read, copy, or upload passwords, private keys, or SSH-agent material.

## Build order from here

1. Map a workspace to an SSH runtime in the existing workspace-runtime registry.
2. Add reconnecting persistent remote PTYs and explicit port-forward controls.
3. Add remote filesystem reads/writes with path confinement and atomic saves.
4. Add remote Git status, diffs, and worktree lifecycle.
5. Add drag/drop transfer with size limits, checksums, and confirmation.

Until those steps land, ADE file browsing, diffs, Design Mode, and terminal persistence operate on local files. Remote commands run through an ordinary terminal session.
