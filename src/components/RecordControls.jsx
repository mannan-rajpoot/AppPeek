import { useEffect, useRef, useState } from "react";
import { ChevronDown, Square, Video, X } from "lucide-react";
import {
  ASPECT_OPTIONS,
  FPS_OPTIONS,
  SIZE_OPTIONS,
  readRec,
  recFormatLabel,
  writeRec,
} from "./useRecorder.js";

export const fmtTime = (s) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function RecToast({ rec, className = "" }) {
  if (!rec.toast) return null;
  return (
    <div
      className={`rec-toast is-${rec.toast.kind} ${className}`}
      role="status"
    >
      <span>{rec.toast.text}</span>
      <button aria-label="Dismiss" onClick={rec.dismiss}>
        <X size={12} />
      </button>
    </div>
  );
}

// Toolbar: [ ● Record ] [v]  → one click records the running app, the chevron opens the options.
export default function RecordControls({ rec, disabled }) {
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState(readRec);
  const ref = useRef(null);
  const st = rec.state;
  const busy = st !== "idle";

  useEffect(() => {
    if (!open) return;
    const down = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const key = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  useEffect(() => {
    if (busy) setOpen(false);
  }, [busy]);

  const set = (patch) =>
    setCfg((p) => {
      const n = { ...p, ...patch };
      writeRec(n);
      return n;
    });
  const pick = (k, list) => (
    <select
      className="select"
      value={cfg[k]}
      onChange={(e) => {
        const raw = e.target.value;
        set({ [k]: /^\d+$/.test(raw) ? Number(raw) : raw });
      }}
    >
      {list.map((o) => (
        <option key={o.v} value={o.v}>
          {o.label}
        </option>
      ))}
    </select>
  );

  const label =
    st === "recording"
      ? "Stop recording (Ctrl+Shift+E)"
      : st === "countdown"
        ? "Cancel"
        : "Record the app UI as a video (Ctrl+Shift+E)";

  return (
    <div className="tb-menu rec" ref={ref}>
      <button
        className={`rec-btn ${st === "recording" ? "is-rec" : ""} ${st === "countdown" ? "is-count" : ""}`}
        title={label}
        aria-label={label}
        onClick={rec.toggle}
        disabled={disabled || st === "starting" || st === "saving"}
      >
        {st === "recording" ? (
          <>
            <i className="rec-dot" />
            <span className="rec-time">{fmtTime(rec.elapsed)}</span>
            <Square size={10} fill="currentColor" />
          </>
        ) : st === "countdown" ? (
          <span className="rec-count">{rec.count}</span>
        ) : st === "starting" || st === "saving" ? (
          <span className="spinner" />
        ) : (
          <>
            <Video size={15} />
            <span>Record</span>
          </>
        )}
      </button>
      <button
        className="icon-btn rec-more"
        title="Recording options"
        aria-label="Recording options"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled || busy}
      >
        <ChevronDown size={14} />
      </button>

      {open && (
        <div className="menu rec-menu" role="menu">
          <label className="menu-row">
            <span>Resolution</span>
            {pick("size", SIZE_OPTIONS)}
          </label>
          <label className="menu-row">
            <span>Background</span>
            <select
              className="select"
              value={cfg.size === "native" || cfg.bg !== false ? "on" : "off"}
              disabled={cfg.size === "native"}
              onChange={(e) => set({ bg: e.target.value === "on" })}
            >
              <option value="on">On (white + shadow)</option>
              <option value="off">Off (phone only)</option>
            </select>
          </label>
          {cfg.bg !== false && cfg.size !== "native" && (
            <label className="menu-row">
              <span>Shape</span>
              {pick("aspect", ASPECT_OPTIONS)}
            </label>
          )}
          <label className="menu-row">
            <span>Frame rate</span>
            {pick("fps", FPS_OPTIONS)}
          </label>
          <label className="menu-row">
            <span>Sharp text</span>
            <select
              className="select"
              value={cfg.sharp === false ? "off" : "on"}
              onChange={(e) => set({ sharp: e.target.value === "on" })}
            >
              <option value="on">On (enlarge while recording)</option>
              <option value="off">Off (keep current size)</option>
            </select>
          </label>
          {cfg.size === "native" && (
            <p className="menu-note">
              Exact 1080×1920 at 60 fps on a white 9:16 canvas. The phone is
              enlarged on screen while recording so every video pixel is real.
              The screen must be tall enough to show the phone about 1700 px
              tall (a 4K or high-DPI display); on smaller screens it is enlarged
              and a note tells you.
            </p>
          )}
          <p className="menu-note">
            {recFormatLabel(cfg.bg !== false || cfg.size === "native")} ·{" "}
            {cfg.bg === false
              ? "only the phone, sized like the phone. Resolution is the phone's long side."
              : "white background, phone and soft shadow."}{" "}
            Auto records at the exact pixels shown (no blur from enlarging), at
            a high bitrate. Sharp text makes the phone as big as the window
            allows while recording.
          </p>
        </div>
      )}
      <RecToast rec={rec} />
    </div>
  );
}
