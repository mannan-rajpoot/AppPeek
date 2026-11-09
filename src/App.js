import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, ask } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Intro from "./components/Intro.jsx";
import Home from "./components/Home.jsx";
import Emulator from "./components/Emulator.jsx";
import Floating, {
  FLOAT_MARGIN,
  readFloatPrefs,
} from "./components/Floating.jsx";
import { getDevice } from "./components/DeviceSelector.jsx";
import { getFrameSize } from "./components/DeviceFrame.jsx";

// server.state: "stopped" | "starting" | "running" | "error" | "lost"
const STOPPED = {
  state: "stopped",
  url: null,
  port: null,
  message: null,
  hint: null,
  external: false,
};
const ACTIVE = ["starting", "running", "lost"];

const RECENT_KEY = "mobilelab.recent";
const PROJECT_KEY = "mobilelab.project";

const inTauri = () =>
  typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

// The floating simulator is the same app loaded in a second window; it only shows the phone.
const IS_FLOATING = inTauri() && getCurrentWindow().label === "floating";
if (IS_FLOATING) document.documentElement.classList.add("is-floating");

export default function App() {
  return IS_FLOATING ? <Floating /> : <Workspace />;
}

const DESKTOP_ONLY = {
  tone: "bad",
  message: "Project connection needs the MobileLab desktop app.",
  hint: "Start it with `npm run tauri dev` instead of the browser-only `npm run dev`.",
};

// Errors from Rust arrive as { message, hint }; anything else becomes a plain message.
const toProblem = (e) =>
  e && typeof e === "object" && e.message
    ? { message: e.message, hint: e.hint || null }
    : { message: String(e), hint: null };

// Several simulators only when the computer has the resources for it.
function getMaxSessions() {
  const mem = navigator.deviceMemory; // GB, rounded; undefined in some webviews
  const cores = navigator.hardwareConcurrency || 4;
  return (mem && mem <= 4) || cores <= 2 ? 1 : 3;
}

function loadRecent() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(raw) ? raw.slice(0, 5) : [];
  } catch {
    return [];
  }
}

function saveRecent(list) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* storage can be unavailable; recents are a convenience only */
  }
}

function readSavedProject() {
  try {
    return localStorage.getItem(PROJECT_KEY) || null;
  } catch {
    return null;
  }
}

function writeSavedProject(path) {
  try {
    if (path) localStorage.setItem(PROJECT_KEY, path);
    else localStorage.removeItem(PROJECT_KEY);
  } catch {
    /* ignore */
  }
}

function Workspace() {
  const [screen, setScreen] = useState("intro"); // intro | home | emulator
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [recent, setRecent] = useState(loadRecent);
  const [maxSessions, setMaxSessions] = useState(getMaxSessions);
  const [project, setProject] = useState(null); // { name, path, manager, warnings, ... }
  const [server, setServer] = useState(STOPPED);
  const [notice, setNotice] = useState(null); // { tone, message, hint }
  const [floatingId, setFloatingId] = useState(null); // session shown in the floating window
  const floatRef = useRef(null);
  const floatHandler = useRef(null);
  const nextId = useRef(1);

  const serverRef = useRef(server);
  serverRef.current = server;
  const projectRef = useRef(project);
  projectRef.current = project;

  const active = sessions.find((s) => s.id === activeId) || null;

  /* ───────── performance: size the workspace to the computer ───────── */

  // Real RAM from the backend decides how many simulators may run at once.
  useEffect(() => {
    if (!inTauri()) return;
    invoke("system_memory_mb")
      .then((mb) => {
        if (mb) setMaxSessions(mb <= 4608 ? 1 : mb <= 8704 ? 2 : 3);
      })
      .catch(() => {});
  }, []);

  // One simulator at a time = low-spec mode: lighter shadows, no decorative motion.
  useEffect(() => {
    document.documentElement.classList.toggle("low-spec", maxSessions === 1);
  }, [maxSessions]);

  // A page reload would wipe running simulators, so block the reload keys everywhere
  // (the simulator's own Ctrl+R refreshes the preview instead).
  useEffect(() => {
    if (!inTauri()) return;
    const onKey = (e) => {
      const reload =
        e.key === "F5" ||
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r");
      if (reload) e.preventDefault();
    };
    const onMenu = (e) => import.meta.env.PROD && e.preventDefault();
    window.addEventListener("keydown", onKey);
    window.addEventListener("contextmenu", onMenu);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("contextmenu", onMenu);
    };
  }, []);

  /* ───────── Expo project + server (Tauri backend) ───────── */

  // Live server state pushed from Rust, and a resync after any webview reload.
  useEffect(() => {
    if (!inTauri()) return;
    let dead = false;
    let unlisten = null;
    listen("server-state", (e) => setServer(e.payload)).then((fn) => {
      if (dead) fn();
      else unlisten = fn;
    });
    invoke("server_status")
      .then((s) => !dead && setServer(s))
      .catch(() => {});
    return () => {
      dead = true;
      if (unlisten) unlisten();
    };
  }, []);

  const loadProject = async (path, { silent = false } = {}) => {
    try {
      const info = await invoke("detect_project", { path });
      const cur = projectRef.current;
      const switching =
        cur &&
        cur.path !== info.path &&
        ACTIVE.includes(serverRef.current.state);
      if (switching) {
        const ok = await ask(
          "An Expo server is running for the current project. Stop it and switch projects?",
          {
            title: "MobileLab",
            kind: "warning",
            okLabel: "Switch",
            cancelLabel: "Cancel",
          },
        );
        if (!ok) return;
        await invoke("stop_server");
      }
      setProject(info);
      writeSavedProject(info.path);
      setNotice(null);
      // Reconnect to a server the developer already started for this folder.
      await invoke("attach_existing", { path: info.path }).catch(() => {});
    } catch (e) {
      if (silent) {
        writeSavedProject(null); // the saved folder moved or is no longer valid
        return;
      }
      setNotice({ tone: "bad", ...toProblem(e) });
    }
  };

  // Restore the last project when MobileLab opens.
  useEffect(() => {
    if (!inTauri()) return;
    const saved = readSavedProject();
    if (saved) loadProject(saved, { silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connectProject = async () => {
    if (!inTauri()) return setNotice(DESKTOP_ONLY);
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        title: "Select your Expo project folder",
      });
      if (!picked) return;
      await loadProject(Array.isArray(picked) ? picked[0] : picked);
    } catch (e) {
      setNotice({ tone: "bad", ...toProblem(e) });
    }
  };

  const failServer = (e) => {
    const p = toProblem(e);
    setServer({ ...STOPPED, state: "error", message: p.message, hint: p.hint });
  };

  const startServer = async () => {
    if (!inTauri()) return setNotice(DESKTOP_ONLY);
    if (!project) return;
    setNotice(null);
    setServer({ ...STOPPED, state: "starting" });
    try {
      await invoke("start_server", { path: project.path });
    } catch (e) {
      failServer(e);
    }
  };

  const stopServer = async () => {
    try {
      await invoke("stop_server");
    } catch (e) {
      failServer(e);
    }
  };

  // Last lines Expo printed, for bug reports.
  const copyLog = async () => {
    try {
      const lines = await invoke("get_log");
      const text = lines.length ? lines.join("\n") : "(no output captured)";
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  };

  const reconnectServer = async () => {
    if (!project) return;
    setNotice(null);
    setServer({ ...STOPPED, state: "starting" });
    try {
      await invoke("reconnect_server", { path: project.path });
    } catch (e) {
      failServer(e);
    }
  };

  /* ───────── simulator sessions (unchanged from Phase 2) ───────── */

  const addRecent = (deviceId) => {
    setRecent((prev) => {
      const next = [
        { deviceId, at: Date.now() },
        ...prev.filter((r) => r.deviceId !== deviceId),
      ].slice(0, 5);
      saveRecent(next);
      return next;
    });
  };

  const updateSession = (id, patch) =>
    setSessions((list) =>
      list.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    );

  // Show `id`; the simulator we leave is parked (minimized) but stays alive.
  const focusSession = (list, id) =>
    list.map((s) =>
      s.id === id
        ? { ...s, minimized: false }
        : s.id === activeId
          ? { ...s, minimized: true }
          : s,
    );

  const openDevice = (deviceId) => {
    let list = sessions;
    let existing = list.find((s) => s.deviceId === deviceId);
    let id;
    if (existing) {
      id = existing.id;
    } else {
      id = nextId.current++;
      // At the resource limit, the oldest session makes room.
      if (list.length >= maxSessions)
        list = list.slice(list.length - maxSessions + 1);
      list = [
        ...list,
        {
          id,
          deviceId,
          landscape: false,
          minimized: false,
          zoom: "fit",
          refreshes: 0,
          reloads: 0,
        },
      ];
    }
    setSessions(focusSession(list, id));
    setActiveId(id);
    addRecent(deviceId);
    setScreen("emulator");
  };

  // Switching device keeps the running page and just resizes the viewport.
  const switchDevice = (id, deviceId) => {
    const other = sessions.find((s) => s.deviceId === deviceId && s.id !== id);
    if (other) {
      setSessions(focusSession(sessions, other.id));
      setActiveId(other.id);
    } else {
      updateSession(id, { deviceId, zoom: "fit" });
    }
    addRecent(deviceId);
  };

  const activate = (id) => {
    setSessions(focusSession(sessions, id));
    setActiveId(id);
  };

  const closeSession = (id) => {
    const remaining = sessions.filter((s) => s.id !== id);
    setSessions(remaining);
    if (remaining.length === 0) {
      setActiveId(null);
      setScreen("home");
    } else if (id === activeId) {
      const next = remaining[remaining.length - 1];
      setActiveId(next.id);
      setSessions(
        remaining.map((s) =>
          s.id === next.id ? { ...s, minimized: false } : s,
        ),
      );
    }
  };

  /* ───────── floating simulator window ───────── */

  const openFloating = async (scalePct) => {
    if (!inTauri()) {
      return setNotice({
        tone: "bad",
        message: "Floating mode needs the MobileLab desktop app.",
        hint: "Start it with `npm run tauri dev` instead of the browser-only `npm run dev`.",
      });
    }
    if (!active) return;
    const d = getDevice(active.deviceId);
    const f = getFrameSize(d, active.landscape);
    const prefs = readFloatPrefs();
    const M = FLOAT_MARGIN;
    const maxScale = Math.min(
      (window.screen.availWidth - 2 * M) / f.width,
      (window.screen.availHeight - 2 * M - 40) / f.height,
      2,
    );
    const wanted = prefs.scale?.[d.id] ?? Math.min(scalePct / 100, 0.8);
    const scale = Math.max(0.25, Math.min(wanted, maxScale));
    const p = prefs.pos;
    const okPos =
      p &&
      Number.isFinite(p.x) &&
      Number.isFinite(p.y) &&
      p.x > -f.width &&
      p.x < window.screen.availWidth * 2 &&
      p.y > -f.height &&
      p.y < window.screen.availHeight * 2;
    try {
      await invoke("open_floating", {
        args: {
          deviceId: d.id,
          landscape: active.landscape,
          scale,
          width: f.width * scale + 2 * M,
          height: f.height * scale + 2 * M,
          x: okPos ? p.x : null,
          y: okPos ? p.y : null,
          onTop: prefs.onTop !== false,
        },
      });
      floatRef.current = active.id;
      setFloatingId(active.id);
    } catch (e) {
      setNotice({ tone: "bad", ...toProblem(e) });
    }
  };

  // Told by the backend when the floating window is gone (button, Esc, taskbar close…).
  floatHandler.current = (p) => {
    const id = floatRef.current;
    floatRef.current = null;
    setFloatingId(null);
    if (id == null) return;
    if (p.closeSession) closeSession(id);
    else if (typeof p.landscape === "boolean")
      updateSession(id, { landscape: p.landscape, zoom: "fit" });
  };
  useEffect(() => {
    if (!inTauri()) return;
    let dead = false;
    let un = null;
    listen("floating-state", (e) => floatHandler.current?.(e.payload)).then(
      (fn) => (dead ? fn() : (un = fn)),
    );
    return () => {
      dead = true;
      if (un) un();
    };
  }, []);

  const startNewPreview = () => openDevice(recent[0]?.deviceId || "iphone-14");

  if (screen === "intro") {
    return <Intro onDone={() => setScreen("home")} />;
  }

  const showEmulator = screen === "emulator" && !!active;

  return (
    <>
      {/* The workspace stays mounted (just hidden) while you visit Home, so running simulators keep their state. */}
      {active && (
        <div
          className={showEmulator ? "screen-enter" : ""}
          style={showEmulator ? undefined : { display: "none" }}
        >
          <Emulator
            visible={showEmulator}
            session={active}
            sessions={sessions}
            maxSessions={maxSessions}
            project={project}
            server={server}
            notice={notice}
            onDismissNotice={() => setNotice(null)}
            onConnect={connectProject}
            onStart={startServer}
            onStop={stopServer}
            onReconnect={reconnectServer}
            onCopyLog={copyLog}
            floatingId={floatingId}
            onFloat={openFloating}
            onUpdate={(patch) => updateSession(active.id, patch)}
            onSwitchDevice={(deviceId) => switchDevice(active.id, deviceId)}
            onActivate={activate}
            onClose={closeSession}
            onHome={() => setScreen("home")}
          />
        </div>
      )}
      {!showEmulator && (
        <div className="screen-enter">
          <Home
            sessions={sessions}
            recent={recent}
            project={project}
            server={server}
            onOpen={openDevice}
            onNewPreview={startNewPreview}
            onResume={() => setScreen("emulator")}
          />
        </div>
      )}
    </>
  );
}
