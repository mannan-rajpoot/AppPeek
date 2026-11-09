import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { Pin, PinOff, RefreshCw, RotateCw, Minimize2, X } from "lucide-react";
import DeviceFrame, { getFrameSize } from "./DeviceFrame.jsx";
import { getDevice } from "./DeviceSelector.jsx";
import { PreviewViewport } from "./Emulator.jsx";

// Transparent ring around the phone: it is the drag area and holds the controls.
export const FLOAT_MARGIN = 30;
const PREFS_KEY = "mobilelab.float"; // { scale: { [deviceId]: n }, pos: {x,y}, onTop: bool }
const STOPPED = {
  state: "stopped",
  url: null,
  port: null,
  message: null,
  hint: null,
  external: false,
};

export function readFloatPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {};
  } catch {
    return {};
  }
}
export function writeFloatPrefs(patch) {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ ...readFloatPrefs(), ...patch }),
    );
  } catch {
    /* preferences are a convenience only */
  }
}

// The floating window: only the phone, on a transparent background. It shows the same
// Expo server the main window uses; nothing is restarted when you enter or leave.
export default function Floating() {
  const win = useMemo(() => getCurrentWindow(), []);
  const [cfg, setCfg] = useState(null);
  const [scale, setScale] = useState(0.6);
  const [landscape, setLandscape] = useState(false);
  const [server, setServer] = useState(STOPPED);
  const [dark, setDark] = useState(false);
  const [refreshes, setRefreshes] = useState(0);
  const [pinned, setPinned] = useState(() => readFloatPrefs().onTop !== false);

  const project = useMemo(() => {
    try {
      const name = (localStorage.getItem("mobilelab.project") || "")
        .split(/[\\/]/)
        .filter(Boolean)
        .pop();
      return name ? { name } : null;
    } catch {
      return null;
    }
  }, []);

  const device = cfg ? getDevice(cfg.deviceId) : null;
  const frame = device ? getFrameSize(device, landscape) : null;

  const now = useRef({});
  now.current = { scale, landscape, frame, device };

  const maxScale = (f) =>
    Math.min(
      (window.screen.availWidth - 2 * FLOAT_MARGIN) / f.width,
      (window.screen.availHeight - 2 * FLOAT_MARGIN) / f.height,
      2,
    );
  const clamp = (s, f) => Math.max(0.25, Math.min(s, maxScale(f)));
  const winSize = (s, f) =>
    new LogicalSize(
      Math.round(f.width * s + 2 * FLOAT_MARGIN),
      Math.round(f.height * s + 2 * FLOAT_MARGIN),
    );

  const applyScale = (s) => {
    const { frame: f } = now.current;
    setScale(s);
    win.setSize(winSize(s, f)).catch(() => {});
  };
  const saveScale = () => {
    const { scale: s, device: d } = now.current;
    writeFloatPrefs({
      scale: { ...(readFloatPrefs().scale || {}), [d.id]: s },
    });
  };

  // Initial config + live server state.
  useEffect(() => {
    let dead = false;
    let un = null;
    invoke("floating_config").then((c) => {
      if (dead || !c) return;
      setCfg(c);
      setScale(c.scale);
      setLandscape(c.landscape);
    });
    listen("server-state", (e) => setServer(e.payload)).then((fn) =>
      dead ? fn() : (un = fn),
    );
    invoke("server_status")
      .then((s) => !dead && setServer(s))
      .catch(() => {});
    return () => {
      dead = true;
      if (un) un();
    };
  }, []);

  // Remember where the window was left.
  useEffect(() => {
    let timer = 0;
    let un = null;
    let dead = false;
    win
      .onMoved(async ({ payload }) => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          try {
            const p = payload.toLogical(await win.scaleFactor());
            writeFloatPrefs({
              pos: { x: Math.round(p.x), y: Math.round(p.y) },
            });
          } catch {
            /* ignore */
          }
        }, 300);
      })
      .then((fn) => (dead ? fn() : (un = fn)));
    return () => {
      dead = true;
      clearTimeout(timer);
      if (un) un();
    };
  }, [win]);

  const leave = (closeSession) =>
    invoke("exit_floating", {
      landscape: now.current.landscape,
      closeSession,
    }).catch(() => {});

  const rotate = async () => {
    const { scale: s0, landscape: l0, frame: f0, device: d } = now.current;
    const f1 = getFrameSize(d, !l0);
    const s1 = clamp(s0, f1);
    const [w0, h0] = [
      f0.width * s0 + 2 * FLOAT_MARGIN,
      f0.height * s0 + 2 * FLOAT_MARGIN,
    ];
    const [w1, h1] = [
      f1.width * s1 + 2 * FLOAT_MARGIN,
      f1.height * s1 + 2 * FLOAT_MARGIN,
    ];
    setLandscape(!l0);
    setScale(s1);
    try {
      const p = (await win.outerPosition()).toLogical(await win.scaleFactor());
      await win.setSize(winSize(s1, f1));
      await win.setPosition(
        new LogicalPosition(p.x + (w0 - w1) / 2, p.y + (h0 - h1) / 2),
      ); // rotate around the centre
    } catch {
      /* ignore */
    }
  };

  const togglePin = async () => {
    const next = !pinned;
    setPinned(next);
    writeFloatPrefs({ onTop: next });
    win.setAlwaysOnTop(next).catch(() => {});
  };

  // Keyboard: Esc leaves, Ctrl+R refreshes the app, Ctrl +/- zooms (the page never reloads or zooms itself).
  const keys = useRef(null);
  keys.current = (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (e.key === "Escape") return leave(false);
    if (e.key === "F5" || (ctrl && k === "r")) {
      e.preventDefault();
      return setRefreshes((n) => n + 1);
    }
    if (ctrl && (k === "=" || k === "+" || k === "-")) {
      e.preventDefault();
      applyScale(
        clamp(
          now.current.scale * (k === "-" ? 1 / 1.1 : 1.1),
          now.current.frame,
        ),
      );
      saveScale();
    }
  };
  useEffect(() => {
    const onKey = (e) => keys.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Ctrl + mouse wheel resizes (non-passive so the page itself doesn't zoom).
  const rootRef = useRef(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      applyScale(
        clamp(
          now.current.scale * (e.deltaY < 0 ? 1.06 : 1 / 1.06),
          now.current.frame,
        ),
      );
      clearTimeout(onWheel.t);
      onWheel.t = setTimeout(saveScale, 400);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [device]); // eslint-disable-line react-hooks/exhaustive-deps

  // Corner grip: resize with the phone's aspect ratio locked (only the visual scale changes).
  const grip = useRef(null);
  const gripDown = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    grip.current = {
      x: e.screenX,
      y: e.screenY,
      scale: now.current.scale,
      frame: now.current.frame,
      raf: 0,
    };
  };
  const gripMove = (e) => {
    const g = grip.current;
    if (!g) return;
    const dx = e.screenX - g.x;
    const dy = e.screenY - g.y;
    const { width: fw, height: fh } = g.frame;
    const next = clamp(
      g.scale + (dx * fw + dy * fh) / (fw * fw + fh * fh),
      g.frame,
    );
    cancelAnimationFrame(g.raf);
    g.raf = requestAnimationFrame(() => applyScale(next));
  };
  const gripUp = () => {
    if (!grip.current) return;
    grip.current = null;
    saveScale();
  };

  if (!device) return <div className="float-root" data-tauri-drag-region />;

  return (
    <div className="float-root" ref={rootRef} data-tauri-drag-region>
      <div
        className="float-bar"
        role="toolbar"
        aria-label="Floating simulator controls"
      >
        <button
          title="Refresh the app (Ctrl+R)"
          aria-label="Refresh"
          onClick={() => setRefreshes((n) => n + 1)}
        >
          <RefreshCw size={13} />
        </button>
        <button title="Rotate" aria-label="Rotate" onClick={rotate}>
          <RotateCw size={13} />
        </button>
        <button
          className={pinned ? "is-on" : ""}
          title={pinned ? "Always on top: on" : "Always on top: off"}
          aria-label="Always on top"
          aria-pressed={pinned}
          onClick={togglePin}
        >
          {pinned ? <Pin size={13} /> : <PinOff size={13} />}
        </button>
        <button
          title="Back to MobileLab (Esc)"
          aria-label="Exit floating mode"
          onClick={() => leave(false)}
        >
          <Minimize2 size={13} />
        </button>
        <button
          title="Close this simulator"
          aria-label="Close simulator"
          onClick={() => leave(true)}
        >
          <X size={13} />
        </button>
      </div>

      <DeviceFrame
        device={device}
        landscape={landscape}
        scale={scale}
        tone={dark ? "dark" : "light"}
      >
        <PreviewViewport
          device={device}
          landscape={landscape}
          refreshes={refreshes}
          project={project}
          server={server}
          onTone={setDark}
          floating
        />
      </DeviceFrame>

      <span
        className="float-grip"
        title="Drag to resize"
        onPointerDown={gripDown}
        onPointerMove={gripMove}
        onPointerUp={gripUp}
        onPointerCancel={gripUp}
      />
    </div>
  );
}
