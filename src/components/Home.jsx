import { Info } from "lucide-react";
import { Logo } from "./Intro.jsx";
import DeviceSelector from "./DeviceSelector.jsx";

// Moves a soft spotlight inside the hovered card so it follows the cursor.
function trackCursor(e) {
  const card = e.target.closest?.(".device-card");
  if (!card) return;
  const r = card.getBoundingClientRect();
  card.style.setProperty("--mx", `${e.clientX - r.left}px`);
  card.style.setProperty("--my", `${e.clientY - r.top}px`);
}

// Home is remounted every time you come back to it, so the logo draws itself again each visit.
export default function Home({ onOpen }) {
  return (
    <div className="home">
      <header className="home-bar">
        <div className="brand">
          <Logo size={26} />
          <span>AppPeek</span>
        </div>
      </header>

      <main className="home-main">
        <div className="home-inner">
          <div className="hero">
            <span className="home-eyebrow">iPhone simulators</span>
            <h1>Choose a device to preview</h1>
            <p>Open your Expo app inside an iPhone frame and test it live.</p>
          </div>

          <section className="block" onMouseMove={trackCursor}>
            <DeviceSelector variant="cards" onSelect={onOpen} />
          </section>
        </div>
      </main>

      <footer className="home-foot">
        <span className="home-foot-item muted">
          <Info size={12} /> iOS-style preview via Expo Web. Not Apple’s iOS
          Simulator.
        </span>
        <span className="home-credit">
          Made by <strong>Mannan Rajpoot</strong>
        </span>
      </footer>
    </div>
  );
}
