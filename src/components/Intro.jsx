import { useEffect, useRef, useState } from "react";

// AppPeek mark: a phone outline holding a lab flask (same as the app icon).
export function Logo({ size = 28, className = "" }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect
        className="logo-stroke"
        pathLength="1"
        x="11"
        y="3"
        width="26"
        height="42"
        rx="7"
      />
      <path className="logo-stroke" pathLength="1" d="M20 8h8" />
      <path
        className="logo-stroke"
        pathLength="1"
        d="M21.5 18h5M22.5 18v6.5L18.2 33a1.6 1.6 0 0 0 1.4 2.4h8.8a1.6 1.6 0 0 0 1.4-2.4l-4.3-8.5V18"
      />
    </svg>
  );
}

// Total time the loader bar takes to fill, then a short fade into Home.
const LOAD_MS = 3000; // how long the intro stays before fading into Home
const BAR_MS = 1200; // loader bar fill time (unchanged)
const FADE_MS = 650;

// The intro sits on top of Home. When it starts to leave, Home mounts underneath and
// animates in while the intro fades out, so the two screens cross-fade with no gap.
export default function Intro({ onLeave, onDone }) {
  const [leaving, setLeaving] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;
  const leave = useRef(onLeave);
  leave.current = onLeave;

  useEffect(() => {
    const reduce = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const wait = reduce ? 600 : LOAD_MS;
    let t2;
    const t1 = setTimeout(() => {
      setLeaving(true);
      leave.current?.();
      t2 = setTimeout(() => done.current?.(), reduce ? 0 : FADE_MS);
    }, wait);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  return (
    <div
      className={`intro ${leaving ? "is-leaving" : ""}`}
      role="status"
      aria-label="Loading AppPeek"
    >
      <div className="intro-inner">
        <Logo size={72} className="intro-logo" />
        <h1 className="intro-title">AppPeek</h1>
        <div className="intro-loader" aria-hidden="true">
          <span
            className="intro-loader-fill"
            style={{ animationDuration: `${BAR_MS}ms` }}
          />
        </div>
      </div>
    </div>
  );
}
