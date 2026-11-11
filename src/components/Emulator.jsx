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
import DeviceFrame, { getFrameSize, getZones } from "./DeviceFrame.jsx";
import VirtualKeyboard from "./Keyboard.jsx";
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

// iOS preview options (shared by the main and floating windows through localStorage).
export const IOS_DEFAULTS = {
  keyboard: "off",
  inspect: false,
  kbResize: false,
  reduceMotion: false,
  scroll: true,
};
const IOS_KEY = "mobilelab.ios";
export function readIos() {
  try {
    return {
      ...IOS_DEFAULTS,
      ...(JSON.parse(localStorage.getItem(IOS_KEY) || "{}") || {}),
    };
  } catch {
    return IOS_DEFAULTS;
  }
}
export function writeIos(v) {
  try {
    localStorage.setItem(IOS_KEY, JSON.stringify(v));
  } catch {
    /* options are a convenience only */
  }
}

const RETURN_LABELS = {
  go: "Go",
  search: "Search",
  send: "Send",
  next: "Next",
  done: "Done",
  previous: "Prev",
};

// Layout inspector overlay: protected system areas + warnings. Drawn by AppPeek on top of the
// preview (pointer-events: none), so it never touches or moves your components.
function InspectOverlay({ zones, issues }) {
  return (
    <div className="inspect" aria-hidden="true">
      {zones.map((z, i) => (
        <i
          key={`z${i}`}
          className={`inspect-zone z-${z.kind}`}
          style={{ left: z.x, top: z.y, width: z.w, height: z.h }}
        />
      ))}
      {issues.map((it, i) => (
        <div
          key={`i${i}`}
          className="inspect-issue"
          style={{ left: it.x, top: it.y, width: it.w, height: it.h }}
        >
          <span
            className="inspect-tag"
            style={{ top: it.y < 22 ? it.h + 1 : -15 }}
          >
            {it.label}
          </span>
        </div>
      ))}
    </div>
  );
}

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
// device's safe-area insets, keyboard size and options, and reports its top colour,
// focus and (optionally) layout problems back. Nothing here edits your components.
export function PreviewViewport({
  device,
  landscape,
  refreshes = 0,
  project,
  server,
  onTone,
  floating = false,
  ios = IOS_DEFAULTS,
  kbForce = false,
  onKbHide,
  onIssues,
}) {
  const ref = useRef(null);
  const lastRefresh = useRef(refreshes);
  const W = landscape ? device.height : device.width;
  const H = landscape ? device.width : device.height;
  const safe = landscape ? device.safeLandscape : device.safe;
  const safeRef = useRef(safe);
  safeRef.current = safe;
  const live = server.state === "running" && !!server.url;
  const [loading, setLoading] = useState(live);
  const [focus, setFocus] = useState({
    editable: false,
    mode: "text",
    decimal: false,
    hint: "",
  });
  const [issues, setIssues] = useState([]);
  const status = useMemo(
    () => statusFor(project, server, floating),
    [project, server.state, server.message, floating],
  );

  // Keyboard: shows when an input is focused (or forced with Ctrl+Shift+K).
  const kbHeight = device.keyboard?.[landscape ? "landscape" : "portrait"] || 0;
  const kbOn = ios.keyboard === "auto" && kbHeight > 0;
  const kbVisible = kbOn && (focus.editable || kbForce);
  const resizeMode = kbVisible && ios.kbResize; // page gets shorter (Android-style) instead of being covered
  const safeEff = useMemo(
    () => (resizeMode ? { ...safe, bottom: 0 } : safe),
    [safe, resizeMode],
  );
  const zones = useMemo(() => {
    const z = getZones(device, landscape);
    if (kbVisible && !ios.kbResize)
      z.push({ kind: "keyboard", x: 0, y: H - kbHeight, w: W, h: kbHeight });
    return z;
  }, [device, landscape, kbVisible, kbHeight, ios.kbResize, W, H]);

  // Page address. The insets ride along once (the page reads them before the app starts);
  // later changes (rotation, device switch) arrive as messages, so they never reload the app.
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
        safe: safeEff,
        status,
      }),
    [post, device.name, landscape, safeEff, status],
  );
  const sendOptions = useCallback(
    () =>
      post({
        type: "mobilelab:options",
        scroll: ios.scroll,
        reduceMotion: ios.reduceMotion,
      }),
    [post, ios.scroll, ios.reduceMotion],
  );
  const sendKeyboard = useCallback(
    () =>
      post({
        type: "mobilelab:keyboard",
        visible: kbVisible,
        height: kbHeight,
        resize: ios.kbResize,
      }),
    [post, kbVisible, kbHeight, ios.kbResize],
  );
  const sendInspect = useCallback(
    () => post({ type: "mobilelab:inspect", on: ios.inspect, zones }),
    [post, ios.inspect, zones],
  );

  useEffect(() => {
    const onMsg = (e) => {
      if (e.source !== ref.current?.contentWindow) return;
      const d = e.data || {};
      if (d.type === "mobilelab:ready") {
        sendViewport();
        sendOptions();
        sendKeyboard();
        sendInspect();
      } else if (d.type === "mobilelab:theme") onTone?.(!!d.dark);
      else if (d.type === "mobilelab:focus")
        setFocus({
          editable: !!d.editable,
          mode: d.mode || "text",
          decimal: !!d.decimal,
          hint: d.hint || "",
        });
      else if (d.type === "mobilelab:issues")
        setIssues(Array.isArray(d.issues) ? d.issues : []);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [sendViewport, sendOptions, sendKeyboard, sendInspect, onTone]);

  useEffect(() => {
    sendViewport();
  }, [sendViewport]);
  useEffect(() => {
    sendOptions();
  }, [sendOptions]);

  // Keyboard / inspector messages are only sent while they matter (or once when they turn off).
  const kbWas = useRef(false);
  useEffect(() => {
    if (!kbVisible && !kbWas.current) return;
    kbWas.current = kbVisible;
    sendKeyboard();
  }, [sendKeyboard, kbVisible]);
  const inspectWas = useRef(false);
  useEffect(() => {
    if (!ios.inspect && !inspectWas.current) return;
    inspectWas.current = ios.inspect;
    sendInspect();
  }, [sendInspect, ios.inspect]);

  useEffect(() => {
    if (!live) {
      onTone?.(false); // the placeholder page is light
      setFocus((f) => (f.editable ? { ...f, editable: false } : f));
    }
  }, [live]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!ios.inspect || !live) setIssues([]);
  }, [ios.inspect, live]);
  useEffect(() => {
    onIssues?.(ios.inspect ? issues.length : 0);
  }, [issues.length, ios.inspect]); // eslint-disable-line react-hooks/exhaustive-deps

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
        style={
          resizeMode ? { height: `calc(100% - ${kbHeight}px)` } : undefined
        }
        onLoad={() => {
          setLoading(false);
          setFocus((f) => (f.editable ? { ...f, editable: false } : f)); // a freshly loaded page has nothing focused
        }}
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
      {ios.inspect && <InspectOverlay zones={zones} issues={issues} />}
      {kbOn && (
        <VirtualKeyboard
          open={kbVisible}
          height={kbHeight}
          bottomInset={safe.bottom}
          layout={focus.mode}
          decimal={focus.decimal}
          returnLabel={RETURN_LABELS[focus.hint] || "return"}
          onKey={(key) => post({ type: "mobilelab:key", key })}
          onDone={() => {
            post({ type: "mobilelab:blur" });
            onKbHide?.();
          }}
        />
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
  vscodeSync = true,
  syncState = "off",
  onToggleSync,
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
  const [issueCounts, setIssueCounts] = useState({}); // per simulator: layout problems found by the inspector
  const [ios, setIos] = useState(readIos);
  const [kbForce, setKbForce] = useState(false);
  const setIosOpt = (patch) =>
    setIos((prev) => {
      const next = { ...prev, ...patch };
      writeIos(next);
      return next;
    });
  const toggleKeyboardNow = () => {
    if (ios.keyboard !== "auto") {
      setIosOpt({ keyboard: "auto" });
      setKbForce(true);
    } else setKbForce((f) => !f);
  };
  // Options changed in the floating window are picked up when we come back.
  useEffect(() => {
    if (floatingId == null) setIos(readIos());
  }, [floatingId]);

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
  const safeNow = landscape ? device.safeLandscape : device.safe;

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
    if (key === "k" && e.shiftKey) {
      e.preventDefault();
      return toggleKeyboardNow();
    }
    if (key === "l" && e.shiftKey) {
      e.preventDefault();
      return setIosOpt({ inspect: !ios.inspect });
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
        vscodeSync={vscodeSync}
        syncState={syncState}
        onToggleSync={onToggleSync}
        ios={ios}
        onIos={setIosOpt}
        issueCount={issueCounts[session.id] || 0}
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
                      ios={ios}
                      kbForce={kbForce}
                      onKbHide={() => setKbForce(false)}
                      onIssues={(n) =>
                        setIssueCounts((c) =>
                          c[s.id] === n ? c : { ...c, [s.id]: n },
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
          {pct}% · safe area {frame.sw - safeNow.left - safeNow.right} ×{" "}
          {frame.sh - safeNow.top - safeNow.bottom} pt
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
