import { Folder, Server } from "lucide-react";

const SERVER_LABELS = {
  stopped: "Stopped",
  starting: "Starting…",
  running: "Running",
  error: "Error",
  lost: "Connection lost",
};

function projectInfo(project) {
  if (!project) return { tone: "idle", value: "No project connected" };
  return { tone: "ok", value: `${project.name} · ${project.manager}` };
}

function serverInfo(server) {
  const tone =
    server.state === "running" ? "ok" : server.state === "error" || server.state === "lost" ? "bad" : server.state === "starting" ? "busy" : "idle";
  const label = SERVER_LABELS[server.state] || "Stopped";
  return { tone, value: server.state === "running" && server.url ? server.url : label };
}

// layout="cards": two labelled boxes (Home).  layout="inline": compact pills (toolbar).
export default function ConnectionStatus({ project, server, layout = "cards" }) {
  const p = projectInfo(project);
  const s = serverInfo(server);

  if (layout === "inline") {
    return (
      <div className="status-inline" role="status" aria-label="Connection status">
        <span className="status-pill" title={p.value}>
          <i className={`dot dot-${p.tone}`} />
          {project ? project.name : "No project"}
        </span>
        <span className="status-pill" title={s.value}>
          <i className={`dot dot-${s.tone}`} />
          Expo: {SERVER_LABELS[server.state] || "Stopped"}
        </span>
      </div>
    );
  }

  return (
    <div className="status-cards">
      <div className="status-card">
        <Folder size={16} />
        <div>
          <span className="status-label">Project</span>
          <span className="status-value">
            <i className={`dot dot-${p.tone}`} />
            {p.value}
          </span>
        </div>
      </div>
      <div className="status-card">
        <Server size={16} />
        <div>
          <span className="status-label">Expo development server</span>
          <span className="status-value">
            <i className={`dot dot-${s.tone}`} />
            {s.value}
          </span>
        </div>
      </div>
    </div>
  );
}
