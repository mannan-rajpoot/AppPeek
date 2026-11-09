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
    </button>
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
