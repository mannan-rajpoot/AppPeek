import { useEffect, useRef, useState } from "react";
import {
  RefreshCw,
  RotateCcw,
  Smartphone,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Minimize2,
  Minus,
  PanelLeftOpen,
  PictureInPicture2,
  Keyboard,
  Ruler,
  SlidersHorizontal,
} from "lucide-react";
import DeviceSelector from "./DeviceSelector.jsx";
import ConnectionStatus from "./ConnectionStatus.jsx";

function Btn({
  icon: Icon,
  label,
  shortcut,
  onClick,
  active,
  disabled,
  rotate,
  badge,
}) {
  return (
    <button
      className={`icon-btn ${active ? "is-active" : ""}`}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon size={16} className={rotate ? "rot90" : ""} />
      {badge ? <b className="icon-badge">{badge}</b> : null}
    </button>
  );
}

// iOS preview options: small dropdown with the settings that change how the page is presented.
function IosMenu({ ios, onIos, disabled }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
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

  const Item = ({ k, title, hint, invert }) => (
    <label className="menu-item">
      <input
        type="checkbox"
        checked={invert ? !ios[k] : !!ios[k]}
        onChange={(e) =>
          onIos({ [k]: invert ? !e.target.checked : e.target.checked })
        }
      />
      <span>
        <strong>{title}</strong>
        <small>{hint}</small>
      </span>
    </label>
  );

  return (
    <div className="tb-menu" ref={ref}>
      <Btn
        icon={SlidersHorizontal}
        label="iOS preview options"
        active={open}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
      />
      {open && (
        <div className="menu" role="menu">
          <Item
            k="scroll"
            title="iOS-style scrolling"
            hint="Hides scrollbars and stops overscroll chaining"
          />
          <Item
            k="kbResize"
            title="Shrink page when keyboard opens"
            hint="Off: the keyboard covers the page, like iOS Safari"
          />
          <Item
            k="reduceMotion"
            title="Reduce motion (test)"
            hint="Freezes CSS animations and transitions in the app"
          />
        </div>
      )}
    </div>
  );
}

export default function PreviewToolbar({
  device,
  landscape,
  zoomLabel,
  fullscreen,
  minimized,
  project,
  server,
  onDevice,
  onRefresh,
  onReload,
  onOrientation,
  onZoomIn,
  onZoomOut,
  onZoomFit,
  onFullscreen,
  onFloat,
  ios,
  onIos,
  issueCount = 0,
  onMinimize,
  onRestore,
}) {
  const off = minimized;
  return (
    <div className="toolbar" role="toolbar" aria-label="Simulator controls">
      <DeviceSelector
        variant="select"
        selectedId={device.id}
        onSelect={onDevice}
      />

      <span className="tb-sep" />
      <Btn
        icon={RefreshCw}
        label="Refresh preview"
        shortcut="Ctrl+R"
        onClick={onRefresh}
        disabled={off}
      />
      <Btn
        icon={RotateCcw}
        label="Reload application (restart the viewport)"
        shortcut="Ctrl+Shift+R"
        onClick={onReload}
        disabled={off}
      />

      <span className="tb-sep" />
      <Btn
        icon={Smartphone}
        label="Portrait"
        shortcut="Ctrl+Shift+O"
        active={!landscape}
        onClick={() => landscape && onOrientation()}
        disabled={off}
      />
      <Btn
        icon={Smartphone}
        rotate
        label="Landscape"
        shortcut="Ctrl+Shift+O"
        active={landscape}
        onClick={() => !landscape && onOrientation()}
        disabled={off}
      />

      <span className="tb-sep" />
      <Btn
        icon={ZoomOut}
        label="Zoom out"
        shortcut="Ctrl+-"
        onClick={onZoomOut}
        disabled={off}
      />
      <button
        className="zoom-label"
        onClick={onZoomFit}
        disabled={off}
        title="Fit to window (Ctrl+0)"
      >
        {zoomLabel}
      </button>
      <Btn
        icon={ZoomIn}
        label="Zoom in"
        shortcut="Ctrl+="
        onClick={onZoomIn}
        disabled={off}
      />

      <span className="tb-sep" />
      <Btn
        icon={fullscreen ? Minimize2 : Maximize2}
        label={fullscreen ? "Exit full screen" : "Full-screen preview"}
        shortcut={fullscreen ? "Esc" : "Ctrl+Shift+F"}
        onClick={onFullscreen}
        disabled={off}
      />
      <Btn
        icon={PictureInPicture2}
        label="Floating mode (simulator on the desktop)"
        shortcut="Ctrl+Shift+P"
        onClick={onFloat}
        disabled={off}
      />
      <span className="tb-sep" />
      <Btn
        icon={Keyboard}
        label={
          ios.keyboard === "auto"
            ? "Keyboard preview: on (shows when an input is focused)"
            : "Keyboard preview: off"
        }
        shortcut="Ctrl+Shift+K shows or hides it"
        active={ios.keyboard === "auto"}
        onClick={() =>
          onIos({ keyboard: ios.keyboard === "auto" ? "off" : "auto" })
        }
        disabled={off}
      />
      <Btn
        icon={Ruler}
        label={
          ios.inspect
            ? `Layout inspector: ${issueCount} issue${issueCount === 1 ? "" : "s"} found`
            : "Layout inspector (safe areas, keyboard)"
        }
        shortcut="Ctrl+Shift+L"
        active={ios.inspect}
        badge={ios.inspect && issueCount ? issueCount : null}
        onClick={() => onIos({ inspect: !ios.inspect })}
        disabled={off}
      />
      <IosMenu ios={ios} onIos={onIos} disabled={off} />
      {minimized ? (
        <Btn
          icon={PanelLeftOpen}
          label="Restore simulator"
          shortcut="Ctrl+M"
          onClick={onRestore}
        />
      ) : (
        <Btn
          icon={Minus}
          label="Minimize simulator"
          shortcut="Ctrl+M"
          onClick={onMinimize}
        />
      )}

      <div className="tb-grow" />
      <ConnectionStatus layout="inline" project={project} server={server} />
    </div>
  );
}
