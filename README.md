# MobileLab

Your React Native development companion. MobileLab previews Expo apps inside realistic iPhone-style simulators on Windows, so you can code in VS Code without a physical phone.

> MobileLab is an iOS-style visual simulator powered by Expo Web. It is **not** Apple's iOS Simulator, and native-only features (camera hardware, Bluetooth, push notifications, some native modules) may need a real device.

**Status: Phase 1 — Desktop UI.** Intro, Home, Emulator workspace, three iPhone frames, toolbar, dock. Expo project connection and server control arrive in Phase 3.

## Requirements (Windows 10/11)

1. [Node.js LTS](https://nodejs.org)
2. [Rust](https://rustup.rs) (installs the MSVC toolchain)
3. Microsoft C++ Build Tools ("Desktop development with C++")
4. WebView2 (already included in Windows 10/11)

Full Tauri 2 prerequisites: https://v2.tauri.app/start/prerequisites/

## Run

```bash
npm install

# 1. Fast UI-only preview in your browser (no Rust needed)
npm run dev          # opens http://localhost:1420

# 2. Real desktop window
npm run tauri dev    # first run compiles Rust, takes a few minutes

# 3. Windows installer
npm run tauri build
```

## App icons (needed once for `tauri dev` / `tauri build`)

Place a square PNG (at least 1024×1024) in the project root, e.g. `app-icon.png`, then run:

```bash
npx tauri icon app-icon.png
```

This fills `src-tauri/icons/`. (If the folder already has icons, skip this.)

## Keyboard shortcuts (simulator)

| Action | Shortcut |
|---|---|
| Refresh preview | Ctrl+R |
| Reload application | Ctrl+Shift+R (same as refresh until Phase 3) |
| Toggle orientation | Ctrl+Shift+O |
| Zoom in / out / fit | Ctrl+= / Ctrl+- / Ctrl+0 |
| Full-screen preview | Ctrl+Shift+F (Esc exits) |
| Minimize / restore | Ctrl+M |

## Add a new iPhone model

Open `src/components/DeviceSelector.jsx` and add one object to the `DEVICES` array. Width and height are logical points (CSS px).

## Structure

```text
src/components/   Intro, Home, Emulator, DeviceFrame, DeviceSelector, PreviewToolbar, ConnectionStatus
src/App.js        screen flow + simulator sessions
src/main.js       mounts React
src/style.css     all styling
src-tauri/        Tauri 2 desktop shell (Rust)
```
