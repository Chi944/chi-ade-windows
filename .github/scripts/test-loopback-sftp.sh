#!/usr/bin/env bash
set -euo pipefail

test "$(uname -s)" = "Darwin"
test -x /usr/bin/ssh
test -x /usr/bin/sftp
test -x /usr/sbin/sshd

state_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/ade-loopback-ssh.XXXXXX")"
remote_root="$state_dir/remote"
pid_file="$state_dir/sshd.pid"
log_file="$state_dir/sshd.log"
known_hosts="$HOME/.ssh/known_hosts"
known_hosts_backup="$state_dir/known_hosts.before"
mkdir -p "$remote_root" "$HOME/.ssh"
chmod 700 "$HOME/.ssh"

if test -f "$known_hosts"; then
	cp "$known_hosts" "$known_hosts_backup"
fi

cleanup() {
	status=$?
	if test -f "$pid_file"; then
		sudo kill "$(cat "$pid_file")" 2>/dev/null || true
	fi
	if test -f "$known_hosts_backup"; then
		cp "$known_hosts_backup" "$known_hosts"
	else
		rm -f "$known_hosts"
	fi
	if test "$status" -ne 0 && test -f "$log_file"; then
		cat "$log_file"
	fi
	rm -rf "$state_dir"
	exit "$status"
}
trap cleanup EXIT

port="$(/usr/bin/python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"
user_name="$(id -un)"

ssh-keygen -q -t ed25519 -N "" -f "$state_dir/host-key"
ssh-keygen -q -t ed25519 -N "" -f "$state_dir/client-key"
cp "$state_dir/client-key.pub" "$state_dir/authorized_keys"
chmod 600 "$state_dir/authorized_keys" "$state_dir/client-key"

cat > "$state_dir/sshd_config" <<EOF
Port $port
ListenAddress 127.0.0.1
HostKey $state_dir/host-key
PidFile $pid_file
AuthorizedKeysFile $state_dir/authorized_keys
StrictModes no
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
UsePAM no
AllowUsers $user_name
AllowAgentForwarding no
AllowTcpForwarding no
X11Forwarding no
PermitUserEnvironment no
Subsystem sftp internal-sftp
LogLevel VERBOSE
EOF

sudo /usr/sbin/sshd -t -f "$state_dir/sshd_config"
sudo /usr/sbin/sshd -f "$state_dir/sshd_config" -E "$log_file"

for _ in {1..30}; do
	if nc -z 127.0.0.1 "$port"; then break; fi
	sleep 0.2
done
nc -z 127.0.0.1 "$port"

# Strict host-key checking must fail before the exact loopback key is pinned.
if /usr/bin/ssh -F none -i "$state_dir/client-key" -p "$port" \
	-o BatchMode=yes -o StrictHostKeyChecking=yes \
	"$user_name@127.0.0.1" true 2>/dev/null; then
	echo "Strict host-key checking unexpectedly accepted an unpinned host" >&2
	exit 1
fi

host_public="$(cut -d' ' -f1,2 "$state_dir/host-key.pub")"
printf '[127.0.0.1]:%s %s\n' "$port" "$host_public" >> "$known_hosts"
chmod 600 "$known_hosts"

/usr/bin/ssh -F none -i "$state_dir/client-key" -p "$port" \
	-o BatchMode=yes -o StrictHostKeyChecking=yes \
	"$user_name@127.0.0.1" true

printf 'hidden\n' > "$remote_root/.hidden.txt"
printf '\000binary\n' > "$remote_root/binary.bin"
/usr/bin/python3 -c 'import sys; open(sys.argv[1], "wb").truncate(1024 * 1024 + 1)' "$remote_root/oversized.txt"
ln -s "$remote_root/.hidden.txt" "$remote_root/link.txt"
mkdir "$remote_root/repo"
git -C "$remote_root/repo" init -b main
git -C "$remote_root/repo" config user.name "ADE CI"
git -C "$remote_root/repo" config user.email "ade-ci@example.invalid"
printf 'loopback\n' > "$remote_root/repo/README.md"
git -C "$remote_root/repo" add README.md
git -C "$remote_root/repo" commit -m "test fixture"

ADE_LIVE_SFTP=1 \
ADE_LIVE_SSH_HOST=127.0.0.1 \
ADE_LIVE_SSH_PORT="$port" \
ADE_LIVE_SSH_USER="$user_name" \
ADE_LIVE_SSH_IDENTITY="$state_dir/client-key" \
ADE_LIVE_SSH_ROOT="$remote_root" \
	bun test apps/desktop/src/main/lib/remote/filesystem.integration.test.ts
