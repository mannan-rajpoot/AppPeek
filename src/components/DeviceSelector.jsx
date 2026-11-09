import DeviceFrame, { getFrameSize } from "./DeviceFrame.jsx";

// ─────────────────────────────────────────────────────────────
//  DEVICE PROFILES — add a new phone by adding one object here.
//  width/height are LOGICAL points (CSS px), not physical pixels.
//  hardware : "home-button" | "notch" | "island"
//  bezel    : distance from the outer edge to the screen (px, 1:1 scale)
//  band     : width of the metal side band inside that bezel
//  finish   : metal colours (highlight, body, shadow)
//  buttons  : side buttons, offset from the top edge and length (px)
//  safe / safeLandscape : safe-area insets reported to the preview
//  keyboard : approximate iOS keyboard height in points, INCLUDING the bottom safe area and the
//             QuickType bar (portrait / landscape). Real heights vary a little by iOS version.
// ─────────────────────────────────────────────────────────────
export const DEVICES = [
  {
    id: "iphone-14",
    name: "iPhone 14",
    short: "14",
    width: 390,
    height: 844,
    hardware: "notch",
    keyboard: { portrait: 291, landscape: 209 },
    bezel: { top: 14, side: 14, bottom: 14 },
    band: 4,
    screenRadius: 47,
    frameRadius: 62,
    finish: { light: "#4b5058", body: "#23262b", dark: "#3a3e45" }, // Midnight
    cutout: { width: 162, height: 31, top: 0, ear: 9 },
    buttons: {
      left: [
        { top: 118, h: 28 },
        { top: 170, h: 60 },
        { top: 240, h: 60 },
      ],
      right: [{ top: 200, h: 96 }],
    },
    safe: { top: 47, bottom: 34, left: 0, right: 0 },
    safeLandscape: { top: 0, bottom: 21, left: 47, right: 47 },
  },
  {
    id: "iphone-15-pro-max",
    name: "iPhone 15 Pro Max",
    short: "15 PM",
    width: 430,
    height: 932,
    hardware: "island",
    keyboard: { portrait: 301, landscape: 215 },
    bezel: { top: 12, side: 12, bottom: 12 },
    band: 4,
    screenRadius: 55,
    frameRadius: 67,
    finish: { light: "#b4b0a8", body: "#76726b", dark: "#9b978f" }, // Natural Titanium
    cutout: { width: 124, height: 36, top: 11, ear: 0 },
    buttons: {
      left: [
        { top: 124, h: 32 },
        { top: 186, h: 64 },
        { top: 262, h: 64 },
      ],
      right: [{ top: 222, h: 104 }],
    },
    safe: { top: 59, bottom: 34, left: 0, right: 0 },
    safeLandscape: { top: 0, bottom: 21, left: 59, right: 59 },
  },
  {
    id: "iphone-18-pro-max",
    name: "iPhone 18 Pro Max",
    short: "18 PM",
    width: 440,
    height: 956,
    hardware: "island",
    keyboard: { portrait: 291, landscape: 209 },
    bezel: { top: 15, side: 15, bottom: 15 },
    band: 4,
    screenRadius: 55,
    frameRadius: 70,
    finish: { light: "#55565a", body: "#26272a", dark: "#3b3c40" }, // Space Black
    cutout: { type: "island", width: 126, height: 37, top: 11 },
    buttons: {
      left: [
        { top: 150, h: 30 }, // Action button
        { top: 210, h: 56 }, // Volume up
        { top: 278, h: 56 }, // Volume down
      ],
      right: [
        { top: 238, h: 90 }, // Power
        { top: 640, h: 48 }, // Camera Control
      ],
    },
    safe: { top: 62, bottom: 34, left: 0, right: 0 },
    safeLandscape: { top: 0, bottom: 21, left: 62, right: 62 },
  },
];

export function getDevice(id) {
  return DEVICES.find((d) => d.id === id) || DEVICES[1];
}

// variant="cards"  → big picker used on the Home screen
// variant="select" → compact dropdown used in the simulator toolbar
export default function DeviceSelector({
  variant = "cards",
  selectedId,
  onSelect,
  actionLabel = "Open",
}) {
  if (variant === "select") {
    return (
      <select
        className="select"
        value={selectedId}
        onChange={(e) => onSelect(e.target.value)}
        aria-label="Device"
        title="Device (Alt+1 / Alt+2 / Alt+3)"
      >
        {DEVICES.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
    );
  }

  return (
    <div className="device-grid">
      {DEVICES.map((d) => {
        const frame = getFrameSize(d, false);
        return (
          <button
            key={d.id}
            className={`device-card ${d.id === selectedId ? "is-selected" : ""}`}
            onClick={() => onSelect(d.id)}
          >
            <div className="device-card-art">
              <DeviceFrame device={d} scale={150 / frame.height}>
                <div className="blank-screen" />
              </DeviceFrame>
            </div>
            <div className="device-card-body">
              <div>
                <strong>{d.name}</strong>
                <span>
                  {d.width} × {d.height} pt
                </span>
              </div>
              <span className="device-card-action">{actionLabel}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
