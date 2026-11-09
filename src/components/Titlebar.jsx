import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { Logo } from "./Intro.jsx";

// Transparent custom title bar (the native one is disabled in tauri.conf.json).
// Empty space drags the window; double-click maximizes or restores it.
export default function TitleBar() {
  const win = useMemo(() => {
    try {
      return window.__TAURI_INTERNALS__ ? getCurrentWindow() : null;
    } catch {
      return null;
    }
  }, []);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!win) return;
    let dead = false;
    let un = null;
    const sync = () =>
      win
        .isMaximized()
        .then((m) => !dead && setMaximized(m))
        .catch(() => {});
    sync();
    win.onResized(sync).then((fn) => (dead ? fn() : (un = fn)));
    return () => {
      dead = true;
      if (un) un();
    };
  }, [win]);

  // In a plain browser (npm run dev) there is no window to control.
  if (!win) return null;

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-brand" data-tauri-drag-region>
        <Logo size={17} tight />
        <span>AppPeek</span>
      </div>
      <div className="titlebar-controls">
        <button
          aria-label="Minimize"
          title="Minimize"
          onClick={() => win.minimize()}
        >
          <Minus size={14} />
        </button>
        <button
          aria-label={maximized ? "Restore" : "Maximize"}
          title={maximized ? "Restore" : "Maximize"}
          onClick={() => win.toggleMaximize()}
        >
          {maximized ? <Copy size={11} /> : <Square size={11} />}
        </button>
        <button
          className="close"
          aria-label="Close"
          title="Close"
          onClick={() => win.close()}
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
