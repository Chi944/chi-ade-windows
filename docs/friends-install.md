# Install a personal ADE build

Personal and Friends builds are unsigned, temporary test artifacts. Share them
only with people who trust you and use repositories with backups. A checksum
detects a changed download, but it does not provide a verified Apple or Windows
publisher identity.

The macOS builds support macOS 12 Monterey or newer. Windows builds target
64-bit Windows 10 and Windows 11.

## Get the correct artifact

The owner runs **GitHub → Actions → Personal and Friends Build → Run workflow**,
waits for all three jobs to pass, and downloads the artifact to share:

| Computer | Artifact |
| --- | --- |
| Windows on Intel or AMD | `personal-windows-x64` |
| Mac with an Apple M1, M2, M3, M4, or later Apple chip | `personal-macos-arm64` |
| Mac with an Intel processor | `personal-macos-x64` |

On a Mac, choose **Apple menu → About This Mac**. A **Chip** value beginning
with Apple means `arm64`; an **Intel Processor** means `x64`.

Verify the files after extracting the downloaded Actions artifact:

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

Actions artifacts are not published releases and do not form an update feed.
For a newer personal build, the owner reruns the workflow and shares the new
installer and checksum. ADE's in-app updater only offers versions the owner has
separately promoted as published GitHub Releases.
