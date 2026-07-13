# Install ADE

ADE provides one direct installer for Windows and one for each Mac processor
type. These are validated, unsigned prerelease builds for Windows 10/11 x64
and macOS 12 Monterey or newer.

A checksum can detect a changed or corrupted download, but it does not provide
a verified Apple or Windows publisher identity.

## Download

| Computer | Installer |
| --- | --- |
| Windows on Intel or AMD | [Download `ADE-Windows-x64.exe`](https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/ADE-Windows-x64.exe) |
| Mac with Apple Silicon | [Download `ADE-macOS-Apple-Silicon.dmg`](https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/ADE-macOS-Apple-Silicon.dmg) |
| Mac with an Intel processor | [Download `ADE-macOS-Intel.dmg`](https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/ADE-macOS-Intel.dmg) |

On a Mac, choose **Apple menu -> About This Mac**. A **Chip** value beginning
with Apple means Apple Silicon; an **Intel Processor** means Intel.

The optional [SHA-256 checksum file](https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/SHA256SUMS.txt)
lists all three installers. GitHub Release downloads are persistent and do not
expire like temporary Actions artifacts; each remains available until a newer
validated build replaces it.

## Install on Windows

1. Run `ADE-Windows-x64.exe`.
2. Approve the Windows permission prompt and choose the installation folder.
3. If Microsoft Defender SmartScreen warns about an unknown publisher,
   continue only if the filename and checksum match this repository.

To calculate the downloaded file's checksum in PowerShell:

```powershell
Get-FileHash .\ADE-Windows-x64.exe -Algorithm SHA256
```

Compare the result with the `ADE-Windows-x64.exe` line in `SHA256SUMS.txt`.

## Install on macOS

1. Open the DMG, drag **ADE** into **Applications**, then eject the DMG.
2. Try to open ADE once. macOS is expected to block an unsigned build.
3. Open **System Settings -> Privacy & Security** and scroll to **Security**.
4. Confirm the blocked app is ADE, choose **Open Anyway**, authenticate, then
   choose **Open** in the final confirmation.

Apple makes **Open Anyway** available only after the first blocked launch and
for about one hour. Follow Apple's supported
[Open Anyway instructions](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unidentified-developer-mh40616/mac).
Do not disable Gatekeeper or run commands that remove quarantine attributes.

To calculate a Mac download's checksum:

```bash
shasum -a 256 ADE-macOS-Apple-Silicon.dmg
# or: shasum -a 256 ADE-macOS-Intel.dmg
```

Compare the result with the matching installer line in `SHA256SUMS.txt`.

## Updates

The `personal-latest` links always point to the newest validated direct-download
build. This unsigned prerelease remains separate from ADE's signed stable
update feed, so install a newer prerelease manually from the same links.
