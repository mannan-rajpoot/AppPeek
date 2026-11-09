import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronLeft,
  FolderOpen,
  Play,
  Square,
  Plus,
  Smartphone,
  X,
  PanelLeftOpen,
  AlertTriangle,
  RefreshCw,
  Minimize2,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import DeviceFrame, { getFrameSize } from "./DeviceFrame.jsx";
import PreviewToolbar from "./PreviewToolbar.jsx";
import { DEVICES, getDevice } from "./DeviceSelector.jsx";

const ZOOM_STEPS = [25, 50, 75, 100, 125, 150, 200];
const STAGE_PADDING = 56;

// Page shown inside the simulator until a project is connected (Phase 3 swaps in
// the Expo Web URL). It reports the REAL viewport size it receives, which proves
// the app gets the exact logical dimensions regardless of the visual scale.
const PREVIEW_DOC = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>
:root{--sat:0px;--sar:0px;--sab:0px;--sal:0px}
*{box-sizing:border-box;margin:0}
html,body{height:100%}
body{font:13px/1.45 -apple-system,"SF Pro Text","Segoe UI",system-ui,sans-serif;color:#0a0a0a;background:#fff;
 user-select:none;-webkit-user-select:none;display:grid;place-items:center;
 padding:var(--sat) var(--sar) var(--sab) var(--sal)}
.guide{position:fixed;top:var(--sat);right:var(--sar);bottom:var(--sab);left:var(--sal);border:1px dashed #e4e4e4;pointer-events:none}
main{text-align:center;max-width:250px;padding:16px;color:#737373}
svg{color:#737373}
h1{font-size:16px;font-weight:600;color:#0a0a0a;margin:10px 0 6px}
.dim{margin-top:16px;font:600 12px ui-monospace,Consolas,monospace;color:#0a0a0a}
small{display:block;margin-top:4px;color:#a3a3a3;font-size:11px}
</style></head><body>
<div class="guide"></div>
<main>
<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/></svg>
<h1 id="t">No project connected</h1>
<p id="p">Connect an Expo project to preview it here.</p>
<div class="dim" id="dim"></div>
<small id="meta"></small>
</main>
<script>
var info={}, loaded=new Date().toLocaleTimeString();
function paint(){
  if(info.status){document.getElementById('t').textContent=info.status.title;document.getElementById('p').textContent=info.status.text;}
  document.getElementById('dim').textContent=innerWidth+' \\u00d7 '+innerHeight+' pt viewport';
  document.getElementById('meta').textContent=(info.name||'')+' \\u00b7 '+(info.landscape?'Landscape':'Portrait')+' \\u00b7 loaded '+loaded;
}
addEventListener('message',function(e){
  if(e.source!==parent)return;
  var d=e.data||{};
  if(d.type==='mobilelab:viewport'){
    info=d; var s=d.safe||{}, r=document.documentElement.style;
    r.setProperty('--sat',(s.top||0)+'px'); r.setProperty('--sar',(s.right||0)+'px');
    r.setProperty('--sab',(s.bottom||0)+'px'); r.setProperty('--sal',(s.left||0)+'px');
    paint();
  } else if(d.type==='mobilelab:refresh'){ location.reload(); }
});
addEventListener('resize',paint);
paint();
parent.postMessage({type:'mobilelab:ready'},'*');
</script></body></html>`;

// What the placeholder page says while there is no live Expo page to show.
export function statusFor(project, server, floating = false) {
  if (!project)
    return {
      title: "No project connected",
      text: "Connect an Expo project to preview it here.",
    };
  if (server.state === "starting")
    return {
      title: "Starting Expo…",
      text: "Waiting for the development server. The first start can take a minute.",
    };
  if (server.state === "error")
    return {
      title: "Server error",
      text: (server.message || "The Expo server stopped.").slice(0, 140),
    };
  if (server.state === "lost")
    return {
      title: "Connection lost",
      text: floating
        ? "The Expo server stopped responding. Exit floating mode to reconnect."
        : "The Expo server stopped responding. Use Reconnect.",
    };
  return {
    title: `${project.name} is ready`,
    text: floating
      ? "Exit floating mode to start the Expo server."
      : "Press Start to run the Expo server.",
  };
}

// The isolated simulator viewport. Its size is the screen's logical size, because
// only the OUTER frame is scaled — never the screen itself. When the Expo server is
// running it shows the real app (Expo Web) in this same iframe; the page gets the
// device's safe-area insets and reports its top colour (for the status bar text).
export function PreviewViewport({
  device,
  landscape,
  refreshes = 0,
  project,
  server,
  onTone,
  floating = false,
}) {
  const ref = useRef(null);
  const lastRefresh = useRef(refreshes);
  const safe = landscape ? device.safeLandscape : device.safe;
  const safeRef = useRef(safe);
  safeRef.current = safe;
  const live = server.state === "running" && !!server.url;
  const [loading, setLoading] = useState(live);
  const status = useMemo(
    () => statusFor(project, server, floating),
    [project, server.state, server.message, floating],
  );

  // Page address. The insets ride along once (the page reads them before the app starts);
  // later changes (rotation) arrive as messages, so rotating never reloads the app.
  const liveUrl = (n) => {
    const s = safeRef.current;
    return `${server.url}/?mlr=${n}#mlsafe=${s.top || 0},${s.right || 0},${s.bottom || 0},${s.left || 0}`;
  };
  const initialSrc = useMemo(
    () => (live ? liveUrl(0) : null),
    [live, server.url],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  const post = useCallback(
    (msg) => ref.current?.contentWindow?.postMessage(msg, "*"),
    [],
  );
  const sendViewport = useCallback(
    () =>
      post({
        type: "mobilelab:viewport",
        name: device.name,
        landscape,
        safe,
        status,
      }),
    [post, device.name, landscape, safe, status],
  );

  useEffect(() => {
    const onMsg = (e) => {
      if (e.source !== ref.current?.contentWindow) return;
      const type = e.data?.type;
      if (type === "mobilelab:ready") sendViewport();
      else if (type === "mobilelab:theme") onTone?.(!!e.data.dark);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [sendViewport, onTone]);

  useEffect(() => {
    sendViewport();
  }, [sendViewport]);

  useEffect(() => {
    if (!live) onTone?.(false); // the placeholder page is light
  }, [live]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (lastRefresh.current === refreshes) return;
    lastRefresh.current = refreshes;
    if (live && ref.current) {
      setLoading(true);
      ref.current.src = liveUrl(refreshes); // new query string = a real reload of the cross-origin page
    } else {
      post({ type: "mobilelab:refresh" });
    }
  }, [refreshes, post, live, server.url]); // eslint-disable-line react-hooks/exhaustive-deps

  // Loading cover until the page reports loaded (with a safety timeout).
  useEffect(() => {
    setLoading(live);
    if (!live) return;
    const t = setTimeout(() => setLoading(false), 12000);
    return () => clearTimeout(t);
  }, [live, server.url]);

  return (
    <>
      <iframe
        key={live ? "live" : "doc"}
        ref={ref}
        className="preview-frame"
        title="Simulator preview"
        onLoad={() => setLoading(false)}
        {...(live ? { src: initialSrc } : { srcDoc: PREVIEW_DOC })}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
        allow="clipboard-read; clipboard-write; geolocation; microphone; camera"
      />
      {live && loading && (
        <div className="preview-loading">
          <span className="spinner" />
          Loading preview…
        </div>
      )}
    </>
  );
}

export default function Emulator({
  visible = true,
  session,
  sessions,
  maxSessions,
  project,
  server,
  notice,
  onDismissNotice,
  onConnect,
  onStart,
  onStop,
  onReconnect,
  onCopyLog,
  floatingId = null,
  onFloat,
  onUpdate,
  onSwitchDevice,
  onActivate,
  onClose,
  onHome,
}) {
  const device = getDevice(session.deviceId);
  const { landscape, minimized, zoom } = session;

  const stageRef = useRef(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [fullscreen, setFullscreen] = useState(false);
  const [tones, setTones] = useState({}); // per simulator: is the app behind the status bar dark?

  // Full screen also takes the whole window fullscreen (no title bar) and leaves it when we go Home.
  const firstFs = useRef(true);
  useEffect(() => {
    if (firstFs.current) {
      firstFs.current = false;
      return;
    }
    if (window.__TAURI_INTERNALS__)
      getCurrentWindow()
        .setFullscreen(fullscreen)
        .catch(() => {});
  }, [fullscreen]);
  useEffect(() => {
    if (!visible && fullscreen) setFullscreen(false);
  }, [visible, fullscreen]);

  // Track the available workspace so each outer frame can fit it.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width < 1 || height < 1) return; // hidden (Home is showing): keep the last real size
      setStage((s) =>
        Math.abs(s.w - width) < 1 && Math.abs(s.h - height) < 1
          ? s
          : { w: width, h: height },
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fitFor = (frame) =>
    Math.max(
      0.2,
      Math.min(
        (stage.w - STAGE_PADDING) / frame.width,
        (stage.h - STAGE_PADDING) / frame.height,
        1,
      ),
    );
  const scaleFor = (s, frame) =>
    s.zoom === "fit" ? fitFor(frame) : s.zoom / 100;

  const frame = getFrameSize(device, landscape);
  const scale = scaleFor(session, frame);
  const pct = Math.round(scale * 100);

  const zoomIn = () => {
    const next = ZOOM_STEPS.find((z) => z > pct);
    if (next) onUpdate({ zoom: next });
  };
  const zoomOut = () => {
    const prev = [...ZOOM_STEPS].reverse().find((z) => z < pct);
    if (prev) onUpdate({ zoom: prev });
  };
  const refresh = () => onUpdate({ refreshes: session.refreshes + 1 }); // soft: reload the page
  const reload = () => onUpdate({ reloads: session.reloads + 1 }); // hard: recreate the viewport
  const toggleOrientation = () =>
    onUpdate({ landscape: !landscape, zoom: "fit" });
  const minimize = () => {
    setFullscreen(false);
    onUpdate({ minimized: true });
  };
  const restore = () => onUpdate({ minimized: false });

  // Server controls and the one-line problem banner.
  const serverActive = ["starting", "running", "lost"].includes(server.state);
  const [dismissed, setDismissed] = useState("");
  const [copied, setCopied] = useState("");
  useEffect(() => {
    setDismissed("");
    setCopied("");
  }, [server.state, project?.path]);
  const copyLog = async () =>
    setCopied((await onCopyLog()) ? "Copied" : "Failed");
  const banner =
    notice ||
    (server.state === "error" && {
      tone: "bad",
      message: server.message || "The Expo server stopped.",
      hint: server.hint,
      log: true,
    }) ||
    (server.state === "lost" && {
      tone: "bad",
      message: "Connection to the Expo server was lost.",
      hint: "The server may have stopped, or the computer went to sleep.",
      reconnect: true,
    }) ||
    (project?.warnings?.length &&
      server.state === "stopped" && {
        tone: "warn",
        message: project.warnings[0],
      }) ||
    null;
  const showBanner = banner && dismissed !== banner.message;

  // Keyboard shortcuts — one stable listener that always sees the latest handlers.
  const keys = useRef(null);
  keys.current = (e) => {
    if (!visible) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (e.key === "Escape" && fullscreen) return setFullscreen(false);
    if (e.altKey && !ctrl && ["1", "2", "3"].includes(e.key)) {
      e.preventDefault();
      return onSwitchDevice(DEVICES[Number(e.key) - 1].id);
    }
    if (!ctrl) return;
    if (key === "m") {
      e.preventDefault();
      return minimized ? restore() : minimize();
    }
    if (minimized) return;
    if (key === "r") {
      e.preventDefault();
      return e.shiftKey ? reload() : refresh();
    }
    if (key === "o" && e.shiftKey) {
      e.preventDefault();
      return toggleOrientation();
    }
    if (key === "p" && e.shiftKey) {
      e.preventDefault();
      return onFloat(pct);
    }
    if (key === "f" && e.shiftKey) {
      e.preventDefault();
      return setFullscreen((f) => !f);
    }
    if (key === "=" || key === "+") {
      e.preventDefault();
      return zoomIn();
    }
    if (key === "-") {
      e.preventDefault();
      return zoomOut();
    }
    if (key === "0") {
      e.preventDefault();
      return onUpdate({ zoom: "fit" });
    }
  };
  useEffect(() => {
    const onKey = (e) => keys.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Ctrl + mouse wheel zooms the simulator (non-passive so the page itself doesn't zoom).
  const wheel = useRef(null);
  wheel.current = (e) => {
    if (!visible || !(e.ctrlKey || e.metaKey) || minimized) return;
    e.preventDefault();
    e.deltaY < 0 ? zoomIn() : zoomOut();
  };
  useEffect(() => {
    const el = stageRef.current;
    const onWheel = (e) => wheel.current(e);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div className={`emulator ${fullscreen ? "is-fullscreen" : ""}`}>
      <header className="em-header">
        <button className="btn btn-ghost" onClick={onHome}>
          <ChevronLeft size={16} /> Home
        </button>
        <div className="em-title">
          <strong>{device.name}</strong>
          <span className="muted">
            {device.width} × {device.height} pt
          </span>
        </div>
        <div className="tb-grow" />
        <div className="em-actions">
          <button
            className="btn"
            onClick={onConnect}
            title="Choose your Expo project folder"
          >
            <FolderOpen size={15} /> Connect Project
          </button>
          <button
            className="btn"
            onClick={onStart}
            disabled={!project || serverActive}
            title={
              project
                ? "Start the Expo development server"
                : "Connect a project first"
            }
          >
            <Play size={14} /> Start
          </button>
          <button
            className="btn"
            onClick={onStop}
            disabled={!serverActive}
            title="Stop the Expo development server"
          >
            <Square size={13} /> Stop
          </button>
        </div>
      </header>

      <PreviewToolbar
        device={device}
        landscape={landscape}
        zoomLabel={zoom === "fit" ? "Fit" : `${zoom}%`}
        fullscreen={fullscreen}
        minimized={minimized}
        project={project}
        server={server}
        onDevice={onSwitchDevice}
        onRefresh={refresh}
        onReload={reload}
        onOrientation={toggleOrientation}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onZoomFit={() => onUpdate({ zoom: "fit" })}
        onFullscreen={() => setFullscreen((f) => !f)}
        onFloat={() => onFloat(pct)}
        onMinimize={minimize}
        onRestore={restore}
      />

      {showBanner && (
        <div className={`notice notice-${banner.tone}`} role="alert">
          <AlertTriangle size={15} />
          <div className="notice-body">
            <strong>{banner.message}</strong>
            {banner.hint && <span>{banner.hint}</span>}
          </div>
          {banner.log && (
            <button className="btn" onClick={copyLog}>
              {copied || "Copy log"}
            </button>
          )}
          {banner.reconnect && (
            <button className="btn" onClick={onReconnect}>
              <RefreshCw size={13} /> Reconnect
            </button>
          )}
          <button
            className="notice-x"
            aria-label="Dismiss"
            onClick={() =>
              notice ? onDismissNotice() : setDismissed(banner.message)
            }
          >
            <X size={13} />
          </button>
        </div>
      )}

      <div className="em-body">
        <aside className="dock" aria-label="Simulator sessions">
          {sessions.map((s) => {
            const d = getDevice(s.deviceId);
            const isActive = s.id === session.id && !s.minimized;
            return (
              <div
                key={s.id}
                className={`dock-item ${isActive ? "is-active" : ""} ${s.minimized ? "is-min" : ""}`}
              >
                <button
                  className="dock-main"
                  onClick={() => onActivate(s.id)}
                  title={
                    s.minimized
                      ? `${d.name} — minimized, click to restore`
                      : `${d.name}`
                  }
                >
                  <Smartphone size={18} />
                  <span>{d.short}</span>
                </button>
                <button
                  className="dock-close"
                  onClick={() => onClose(s.id)}
                  title={`Close ${d.name}`}
                  aria-label={`Close ${d.name}`}
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
          {sessions.length < maxSessions && (
            <button
              className="dock-add"
              onClick={onHome}
              title="Open another simulator"
              aria-label="Open another simulator"
            >
              <Plus size={16} />
            </button>
          )}
        </aside>

        <main className="stage" ref={stageRef}>
          {/* Every opened session stays mounted (hidden when minimized) so its page keeps running. */}
          {sessions.map((s) => {
            const d = getDevice(s.deviceId);
            const f = getFrameSize(d, s.landscape);
            const shown = s.id === session.id && !s.minimized;
            return (
              <div
                key={s.id}
                className="stage-inner"
                style={shown ? undefined : { display: "none" }}
              >
                <DeviceFrame
                  device={d}
                  landscape={s.landscape}
                  scale={scaleFor(s, f)}
                  tone={tones[s.id] ? "dark" : "light"}
                >
                  {floatingId === s.id ? (
                    /* the floating window owns this app now: never run two copies */
                    <div className="blank-screen" />
                  ) : (
                    <PreviewViewport
                      key={s.reloads}
                      device={d}
                      landscape={s.landscape}
                      refreshes={s.refreshes}
                      project={project}
                      server={server}
                      onTone={(dark) =>
                        setTones((t) =>
                          t[s.id] === dark ? t : { ...t, [s.id]: dark },
                        )
                      }
                    />
                  )}
                </DeviceFrame>
              </div>
            );
          })}

          {minimized && (
            <div className="stage-note">
              <PanelLeftOpen size={22} />
              <p>{device.name} is minimized to the dock. It keeps running.</p>
              <button className="btn btn-primary" onClick={restore}>
                Restore simulator
              </button>
            </div>
          )}
        </main>
      </div>

      {fullscreen && (
        <button
          className="fs-exit"
          onClick={() => setFullscreen(false)}
          title="Exit full screen (Esc)"
        >
          <Minimize2 size={14} /> Exit full screen <kbd>Esc</kbd>
        </button>
      )}

      <footer className="em-footer">
        <span>
          {frame.sw} × {frame.sh} pt · {landscape ? "Landscape" : "Portrait"} ·{" "}
          {pct}%
          {maxSessions === 1 && (
            <span className="low-mem">
              {" "}
              · Low-memory mode: one simulator at a time
            </span>
          )}
        </span>
        <span className="muted">
          iOS-style preview via Expo Web. Native-only features may need a real
          device.
        </span>
      </footer>
    </div>
  );
}
