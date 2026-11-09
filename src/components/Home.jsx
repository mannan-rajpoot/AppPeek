import { useRef } from "react";
import { Plus, LayoutGrid, Clock, Home as HomeIcon, ArrowRight, Info } from "lucide-react";
import { Logo } from "./Intro.jsx";
import DeviceSelector, { getDevice } from "./DeviceSelector.jsx";
import ConnectionStatus from "./ConnectionStatus.jsx";

function timeAgo(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function Home({ sessions, recent, project, server, onOpen, onNewPreview, onResume }) {
  const mainRef = useRef(null);
  const devicesRef = useRef(null);
  const recentRef = useRef(null);

  const jump = (ref) => ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  const top = () => mainRef.current?.scrollTo({ top: 0, behavior: "smooth" });

  return (
    <div className="home">
      <aside className="sidebar">
        <div className="brand">
          <Logo size={22} />
          <span>MobileLab</span>
        </div>

        <nav className="nav">
          <button className="nav-item is-active" onClick={top}>
            <HomeIcon size={16} />
            <span>Home</span>
          </button>
          <button className="nav-item" onClick={() => jump(devicesRef)}>
            <LayoutGrid size={16} />
            <span>Simulators</span>
          </button>
          <button className="nav-item" onClick={() => jump(recentRef)}>
            <Clock size={16} />
            <span>Recent</span>
          </button>
        </nav>

        <div className="sidebar-foot">
          <Info size={14} />
          <p>iOS-style preview powered by Expo Web. Not Apple’s iOS Simulator.</p>
        </div>
      </aside>

      <main className="home-main" ref={mainRef}>
        <div className="home-inner">
          <header className="home-head">
            <div>
              <h1>Welcome to MobileLab</h1>
              <p>Preview your Expo app in an iPhone-style simulator while you code in VS Code.</p>
            </div>
            <div className="home-actions">
              {sessions.length > 0 && (
                <button className="btn" onClick={onResume}>
                  Resume ({sessions.length}) <ArrowRight size={15} />
                </button>
              )}
              <button className="btn btn-primary" onClick={onNewPreview}>
                <Plus size={16} /> Start New Preview
              </button>
            </div>
          </header>

          <section className="block">
            <ConnectionStatus project={project} server={server} />
          </section>

          <section className="block" ref={devicesRef}>
            <h2>Simulators</h2>
            <DeviceSelector variant="cards" onSelect={onOpen} />
          </section>

          <section className="block" ref={recentRef}>
            <h2>Recently opened</h2>
            {recent.length === 0 ? (
              <p className="empty">No simulators opened yet. Pick a device above to start.</p>
            ) : (
              <ul className="recent">
                {recent.map((r) => {
                  const d = getDevice(r.deviceId);
                  return (
                    <li key={r.deviceId}>
                      <button className="recent-row" onClick={() => onOpen(r.deviceId)}>
                        <strong>{d.name}</strong>
                        <span className="muted">
                          {d.width} × {d.height} pt
                        </span>
                        <span className="muted recent-time">{timeAgo(r.at)}</span>
                        <ArrowRight size={15} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
