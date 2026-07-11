# Install a personal ADE build

Personal distribution builds are unsigned test packages. Distribute them only
to trusted users and use repositories with backups. A checksum detects a
changed download, but it does not provide a verified Apple or Windows publisher
identity.

The macOS builds support macOS 12 Monterey or newer. Windows builds target
64-bit Windows 10 and Windows 11.

## Get the correct artifact

The owner runs **GitHub → Actions → Personal Distribution Build → Run
workflow** and waits for the three package jobs plus the archive job to pass.
The workflow temporarily transfers each platform package through Actions, then
collects them in a persistent draft prerelease:

| Computer | Draft Release files | Checksum |
| --- | --- | --- |
| Windows on Intel or AMD | `ADE-<version>-x64.exe` | `SHA256SUMS-windows-x64.txt` |
| Mac with an Apple M1, M2, M3, M4, or later Apple chip | `ADE-<version>-arm64.dmg` or `.zip` | `SHA256SUMS-macos-arm64.txt` |
| Mac with an Intel processor | `ADE-<version>-x64.dmg` or `.zip` | `SHA256SUMS-macos-x64.txt` |

On a Mac, choose **Apple menu → About This Mac**. A **Chip** value beginning
with Apple means `arm64`; an **Intel Processor** means `x64`.

Actions staging artifacts are deleted after the draft is created, with a
one-day expiry as a cleanup fallback. Download from the draft prerelease, which
contains the validated installers and checksums and remains available to the
repository owner until manually deleted. Because this repository is public,
publishing the draft would make its unsigned files public; keep it as a draft
and distribute downloaded files through a trusted channel.

Verify the downloaded files:

```bash
cd /path/to/extracted-artifact
shasum -a 256 -c SHA256SUMS-macos-arm64.txt  # or ...-macos-x64.txt
```

Every listed file should report `OK`. Confirm the expected checksum with the
owner over a separate trusted channel.

## Install on macOS

1. Open the DMG, drag **ADE** into **Applications**, then eject the DMG.
2. Try to open ADE once. macOS is expected to block an unsigned build.
3. Open **System Settings → Privacy & Security** and scroll to **Security**.
4. Confirm the blocked app is ADE, choose **Open Anyway**, authenticate, then
   choose **Open** in the final confirmation.

Apple makes **Open Anyway** available only after the first blocked launch and
for about one hour. Follow Apple's supported
[Open Anyway instructions](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unidentified-developer-mh40616/mac).
Do not disable Gatekeeper or run commands that remove quarantine attributes. If
the app name, checksum, or warning differs from what the owner described, stop.

## Install on Windows

Verify the installer in PowerShell, comparing the result with
`SHA256SUMS-windows-x64.txt`:

```powershell
Get-FileHash .\ADE-*-x64.exe -Algorithm SHA256
```

Run the installer. If Microsoft Defender SmartScreen warns about an unknown
publisher, continue only after confirming the checksum and sender.

## Updates

Temporary Actions artifacts and persistent draft archives do not form an update
feed. For a newer personal build, the owner reruns the workflow and distributes
the new installer and checksum. ADE's in-app updater only offers versions the
owner has separately promoted as published stable GitHub Releases.
