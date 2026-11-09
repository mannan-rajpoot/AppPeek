import { useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";

// MobileLab mark: a phone outline holding a lab flask.
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
      <rect className="logo-stroke" pathLength="1" x="11" y="3" width="26" height="42" rx="7" />
      <path className="logo-stroke" pathLength="1" d="M20 8h8" />
      <path
        className="logo-stroke"
        pathLength="1"
        d="M21.5 18h5M22.5 18v6.5L18.2 33a1.6 1.6 0 0 0 1.4 2.4h8.8a1.6 1.6 0 0 0 1.4-2.4l-4.3-8.5V18"
      />
    </svg>
  );
}

export default function Intro({ onDone }) {
  const [leaving, setLeaving] = useState(false);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const start = () => {
    if (leaving) return;
    setLeaving(true);
    timer.current = setTimeout(onDone, 420);
  };

  return (
    <div className={`intro ${leaving ? "is-leaving" : ""}`}>
      <div className="intro-inner">
        <Logo size={76} className="intro-logo" />
        <h1 className="intro-title">MobileLab</h1>
        <p className="intro-sub">Your React Native development companion.</p>
        <button className="btn btn-invert intro-cta" onClick={start} autoFocus>
          Get Started <ArrowRight size={16} />
        </button>
      </div>
    </div>
  );
}
