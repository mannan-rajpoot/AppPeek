import { useEffect, useState } from "react";

// Size of the whole phone (bezel + screen) at 1:1 scale.
// The screen itself ALWAYS keeps the device's logical width × height.
export function getFrameSize(device, landscape) {
  const { width, height, bezel } = device;
  const sw = landscape ? height : width;
  const sh = landscape ? width : height;
  // Rotating the phone counter-clockwise: top → left, bottom → right.
  const b = landscape
    ? {
        top: bezel.side,
        bottom: bezel.side,
        left: bezel.top,
        right: bezel.bottom,
      }
    : {
        top: bezel.top,
        bottom: bezel.bottom,
        left: bezel.side,
        right: bezel.side,
      };
  return {
    sw,
    sh,
    b,
    width: sw + b.left + b.right,
    height: sh + b.top + b.bottom,
  };
}

/* ───────── iOS status-bar glyphs ───────── */
function SignalBars({ h = 11 }) {
  return (
    <svg
      width={(17 / 11) * h}
      height={h}
      viewBox="0 0 17 11"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="0" y="7.5" width="3" height="3.5" rx="1" />
      <rect x="4.7" y="5" width="3" height="6" rx="1" />
      <rect x="9.3" y="2.5" width="3" height="8.5" rx="1" />
      <rect x="14" y="0" width="3" height="11" rx="1" />
    </svg>
  );
}

function SignalDots() {
  return (
    <svg
      width="31"
      height="6"
      viewBox="0 0 31 6"
      fill="currentColor"
      aria-hidden="true"
    >
      {[0, 6.2, 12.4, 18.6, 24.8].map((x) => (
        <circle key={x} cx={x + 3} cy="3" r="2.6" />
      ))}
    </svg>
  );
}

function WifiIcon({ h = 12 }) {
  return (
    <svg
      width={(16 / 12) * h}
      height={h}
      viewBox="0 0 16 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M1.64 4.64A9 9 0 0 1 14.36 4.64" />
      <path d="M3.76 6.76A6 6 0 0 1 12.24 6.76" />
      <path d="M5.88 8.88A3 3 0 0 1 10.12 8.88" />
      <circle cx="8" cy="10.6" r="0.9" fill="currentColor" />
    </svg>
  );
}

function Battery({ w = 27 }) {
  return (
    <svg
      width={w}
      height={(13 / 27) * w}
      viewBox="0 0 27 13"
      aria-hidden="true"
    >
      <rect
        x="0.5"
        y="0.5"
        width="22"
        height="12"
        rx="3.8"
        fill="none"
        stroke="currentColor"
        opacity="0.4"
      />
      <rect x="2" y="2" width="19" height="9" rx="2.5" fill="currentColor" />
      <path
        d="M24 4.4v4.2c.9-.3 1.6-1.2 1.6-2.1S24.900 4.700 24 4.400Z"
        fill="currentColor"
        opacity="0.45"
      />
    </svg>
  );
}

function Clock({ ampm = false }) {
  const fmt = () => {
    const d = new Date();
    const t = `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")}`;
    return ampm ? `${t} ${d.getHours() < 12 ? "AM" : "PM"}` : t;
  };
  const [time, setTime] = useState(fmt);
  useEffect(() => {
    const id = setInterval(() => setTime(fmt()), 30000);
    return () => clearInterval(id);
  }, [ampm]);
  return <span className="sb-time">{time}</span>;
}

function StatusBar({ device }) {
  if (device.hardware === "home-button") {
    return (
      <div className="statusbar sb-home" style={{ height: device.safe.top }}>
        <div className="sb-left">
          <SignalDots />
          <span>Carrier</span>
          <WifiIcon h={10} />
        </div>
        <div className="sb-center">
          <Clock ampm />
        </div>
        <div className="sb-right">
          <span>100%</span>
          <Battery w={23} />
        </div>
      </div>
    );
  }
  return (
    <div
      className={`statusbar sb-${device.hardware}`}
      style={{ height: device.safe.top }}
    >
      <div className="sb-left">
        <Clock />
      </div>
      <div style={{ width: device.cutout.width + device.cutout.ear * 2 }} />
      <div className="sb-right">
        <SignalBars />
        <WifiIcon h={12} />
        <Battery w={27} />
      </div>
    </div>
  );
}

/* ───────── Notch / Dynamic Island ───────── */
function Cutout({ device }) {
  const { width: cw, height: ch, ear } = device.cutout;
  const total = cw + ear * 2;

  if (device.hardware === "notch") {
    const br = 20; // bottom corner radius
    const d = `M0 0Q${ear} 0 ${ear} ${ear}V${ch - br}Q${ear} ${ch} ${ear + br} ${ch}H${ear + cw - br}Q${ear + cw} ${ch} ${ear + cw} ${ch - br}V${ear}Q${ear + cw} 0 ${total} 0Z`;
    return (
      <div className="cutout notch">
        <svg
          width={total}
          height={ch}
          viewBox={`0 0 ${total} ${ch}`}
          aria-hidden="true"
        >
          <path d={d} fill="#000" />
        </svg>
        <i className="n-speaker" />
        <i className="n-lens" />
      </div>
    );
  }

  return (
    <div className="cutout island">
      <i className="i-sensor" />
      <i className="i-lens" />
    </div>
  );
}

// tone: "dark" when the app behind the status bar is dark (white system text), else "light".
export default function DeviceFrame({
  device,
  landscape = false,
  scale = 1,
  tone = "light",
  children,
}) {
  const f = getFrameSize(device, landscape);
  const cut = device.cutout;

  const vars = {
    width: f.width,
    height: f.height,
    transform: `scale(${scale})`,
    "--s": scale,
    "--sw": `${f.sw}px`,
    "--sh": `${f.sh}px`,
    "--bt": `${f.b.top}px`,
    "--br": `${f.b.right}px`,
    "--bb": `${f.b.bottom}px`,
    "--bl": `${f.b.left}px`,
    "--sr": `${device.screenRadius}px`,
    "--fr": `${device.frameRadius}px`,
    "--band": `${device.band}px`,
    "--f1": device.finish.light,
    "--f2": device.finish.body,
    "--f3": device.finish.dark,
    "--cw": cut ? `${cut.width}px` : "0px",
    "--ch": cut ? `${cut.height}px` : "0px",
    "--ct": cut ? `${cut.top}px` : "0px",
    "--cwt": cut ? `${cut.width + cut.ear * 2}px` : "0px",
  };

  // Rotated counter-clockwise: left edge → bottom edge, right edge → top edge.
  const buttons = [
    ...device.buttons.left.map((b) => ({ ...b, side: "left" })),
    ...device.buttons.right.map((b) => ({ ...b, side: "right" })),
  ];

  return (
    // The wrapper reserves the *scaled* size in the layout. Only the outer
    // frame is visually scaled; the screen inside keeps its logical size.
    <div
      className="device-scale"
      style={{ width: f.width * scale, height: f.height * scale }}
    >
      <div
        className={`device hw-${device.hardware} ${landscape ? "landscape" : "portrait"}`}
        style={vars}
      >
        {buttons.map((b, i) => {
          const edge = landscape
            ? b.side === "left"
              ? "bottom"
              : "top"
            : b.side;
          const pos = landscape
            ? { left: b.top, width: b.h }
            : { top: b.top, height: b.h };
          return (
            <span key={i} className={`side-btn edge-${edge}`} style={pos} />
          );
        })}

        <span className="glass" />

        {device.hardware === "home-button" && (
          <>
            <span className="hw-camera" />
            <span className="hw-speaker" />
            <span className="hw-sensor" />
            <span className="hw-home-btn">
              <i />
            </span>
          </>
        )}

        <div className={`screen${tone === "dark" ? " tone-dark" : ""}`}>
          <div className="viewport">{children}</div>
          {!landscape && <StatusBar device={device} />}
          {cut && <Cutout device={device} />}
          {device.hardware !== "home-button" && (
            <div className="home-indicator" />
          )}
        </div>
      </div>
    </div>
  );
}
