# Development

Run the dev server without env validation or auth:

```bash
SKIP_ENV_VALIDATION=1 bun run dev
```

This skips environment variable validation and the sign-in screen, useful for local development without credentials.

# Release

When building for release, run `bun run prebuild` first so native modules are copied into the desktop package and validated, then run `bun run release`.

# Windows (NSIS) local build

For the smallest temporary disk footprint, install Bun and Node.js, make about
4 GiB of temporary free space available, and run this once from the repository
root in Windows PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-windows-lean.ps1
```

It prunes unused workspaces, validates the published native prebuilds under
Electron, creates the NSIS installer, copies outputs to `artifacts/`, and cleans
its staging directory after success. It deliberately avoids
`electron-builder install-app-deps`, which otherwise requires the large Visual
Studio/Spectre native toolchain on Windows.

For an already-installed full source tree, the equivalent manual package steps
are below.

From `apps/desktop` in PowerShell, cmd, or Git Bash:

```bash
bun run clean:dev
bun run compile:app
bun run package -- --publish never --config electron-builder.ts
```

Expected outputs in `apps/desktop/release/`:

- `ADE-<version>-x64.exe`
- `latest.yml` (Windows auto-update manifest)

Unsigned local Windows builds leave executable signing/resource editing off by default unless Windows signing credentials are configured. Set `ADE_WIN_EDIT_EXECUTABLE=true` to force executable metadata/icon editing in a Developer Mode or elevated shell.

# Linux (AppImage) local build

From `apps/desktop`:

```bash
bun run clean:dev
bun run compile:app
bun run package -- --publish never --config electron-builder.ts
```

Expected outputs in `apps/desktop/release/`:

- `*.AppImage`
- `*-linux.yml` (Linux auto-update manifest)

# Linux auto-update verification (local)

From `apps/desktop` after packaging:

```bash
ls -la release/*.AppImage
ls -la release/*-linux.yml
```

If both files exist, packaging produced the Linux artifact + updater metadata that `electron-updater` expects.
