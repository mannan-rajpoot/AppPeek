import { useCallback, useEffect, useRef, useState } from "react";

// ─────────────────────────────────────────────────────────────
//  App UI recorder.
//  Captures the simulator phone (screen capture), crops it exactly, and re-draws every frame onto a
//  canvas: white background + soft shadow + the phone with rounded corners. The canvas is what gets
//  encoded, so the video always has the final "showcase" look at the chosen resolution.
//  Nothing here touches the Expo app or your components.
// ─────────────────────────────────────────────────────────────

export const REC_DEFAULTS = {
  size: "auto",
  aspect: "1:1",
  fps: "auto",
  bg: true,
};
const REC_KEY = "mobilelab.rec";
export function readRec() {
  try {
    return {
      ...REC_DEFAULTS,
      ...(JSON.parse(localStorage.getItem(REC_KEY) || "{}") || {}),
    };
  } catch {
    return REC_DEFAULTS;
  }
}
export function writeRec(v) {
  try {
    localStorage.setItem(REC_KEY, JSON.stringify(v));
  } catch {
    /* options are a convenience only */
  }
}

export const SIZE_OPTIONS = [
  { v: "auto", label: "Auto (best for this PC)" },
  { v: 720, label: "720p" },
  { v: 1080, label: "1080p Full HD" },
  { v: 1440, label: "1440p 2K" },
  { v: 2160, label: "2160p 4K (strong PC)" },
];
export const ASPECT_OPTIONS = [
  { v: "1:1", label: "Square 1:1" },
  { v: "4:5", label: "Portrait 4:5" },
  { v: "9:16", label: "Story 9:16" },
];
export const FPS_OPTIONS = [
  { v: "auto", label: "Auto" },
  { v: 30, label: "30 fps" },
  { v: 60, label: "60 fps" },
];

const ASPECT = { "1:1": 1, "4:5": 0.8, "9:16": 9 / 16 }; // width / height
const PAD = 0.055; // empty margin around the phone, as a share of the canvas
const MAX_SECONDS = 600; // safety stop
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

const MIME_LIST = [
  "video/mp4;codecs=avc1.640034",
  "video/mp4;codecs=avc1.64002A",
  "video/mp4;codecs=avc1",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];
const ALPHA_MIME_LIST = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];
export function pickMime(alpha = false) {
  if (typeof MediaRecorder === "undefined") return null;
  return (
    (alpha ? ALPHA_MIME_LIST : MIME_LIST).find((m) =>
      MediaRecorder.isTypeSupported(m),
    ) || null
  );
}
export function recFormatLabel(bg = true) {
  const m = pickMime(!bg);
  if (!m) return "Not supported";
  return m.startsWith("video/mp4")
    ? "MP4 (H.264)"
    : bg
      ? "WebM"
      : "WebM with transparent background";
}

// Resolution / frame-rate / bitrate for this recording. "Auto" matches the real pixels that are
// on screen (never blows a small capture up) and picks a frame rate the PC can sustain.
export function makePlan(cfg, frameW, frameH, srcScale) {
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4;
  const strong = cores >= 8 && mem >= 8;
  const fps = cfg.fps === "auto" ? (cores >= 6 ? 60 : 30) : Number(cfg.fps);
  if (cfg.bg === false) {
    // phone only: the video has the phone's own proportions, "resolution" is its long side
    const long = Math.max(frameW, frameH);
    const cap = strong ? 1440 : 1080;
    const L =
      cfg.size === "auto"
        ? Math.max(480, Math.min(Math.round(srcScale * long), cap))
        : Number(cfg.size);
    const k = L / long;
    const W = even(frameW * k);
    const H = even(frameH * k);
    const bps = Math.round(Math.min(45e6, Math.max(3e6, W * H * fps * 0.12)));
    return { W, H, fps, bps, bg: false };
  }
  const r = ASPECT[cfg.aspect] || 1;
  let short;
  if (cfg.size === "auto") {
    const wanted = (srcScale * Math.max(frameW, frameH * r)) / (1 - 2 * PAD);
    short = wanted <= 800 ? 720 : wanted <= 1260 ? 1080 : 1440;
    short = Math.min(short, strong ? 1440 : 1080);
  } else short = Number(cfg.size);
  const W = even(short);
  const H = even(short / r);
  const bps = Math.round(Math.min(45e6, Math.max(4e6, W * H * fps * 0.1)));
  return { W, H, fps, bps, bg: true };
}

// Static part of every frame: white background + soft shadow (falls to the right, like the
// reference clip), the rounded clip path and where the phone goes. Built once, not per frame.
function buildLayout(W, H, frameW, frameH, radius, withBg = true) {
  const pad = withBg ? PAD : 0;
  const k = Math.min(
    (W * (1 - 2 * pad)) / frameW,
    (H * (1 - 2 * pad)) / frameH,
  );
  const dw = frameW * k;
  const dh = frameH * k;
  const dx = (W - dw) / 2;
  const dy = (H - dh) / 2;
  const rr = radius * k;

  if (!withBg) {
    // phone only: no backdrop, no shadow; the area outside the rounded corners stays transparent
    const clip = new Path2D();
    clip.roundRect(dx, dy, dw, dh, rr);
    return { fw: frameW, fh: frameH, k, bg: null, clip, dx, dy, dw, dh };
  }
  const bg = document.createElement("canvas");
  bg.width = W;
  bg.height = H;
  const c = bg.getContext("2d");
  c.fillStyle = "#fff";
  c.fillRect(0, 0, W, H);
  const OFF = W * 3; // draw the shape off-canvas so only its shadow lands on the canvas
  const shadow = (blur, ox, oy, alpha) => {
    c.save();
    c.shadowColor = `rgba(0,0,0,${alpha})`;
    c.shadowBlur = blur;
    c.shadowOffsetX = OFF + ox;
    c.shadowOffsetY = oy;
    c.fillStyle = "#000";
    c.beginPath();
    c.roundRect(dx - OFF, dy, dw, dh, rr);
    c.fill();
    c.restore();
  };
  shadow(H * 0.07, W * 0.026, H * 0.014, 0.2);
  shadow(H * 0.014, W * 0.006, H * 0.004, 0.16);

  const clip = new Path2D();
  clip.roundRect(dx, dy, dw, dh, rr);
  return { fw: frameW, fh: frameH, k, bg, clip, dx, dy, dw, dh };
}

// Where the phone is inside the captured video, in video pixels.
function sourceRect(v, surface, cropped, el) {
  const vw = v.videoWidth;
  const vh = v.videoHeight;
  if (vw < 2 || vh < 2) return null;
  if (cropped) return { sx: 0, sy: 0, sw: vw, sh: vh };
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  let ox = 0;
  let oy = 0;
  let kx;
  let ky;
  if (surface === "monitor") {
    const bx = (window.outerWidth - window.innerWidth) / 2;
    ox = window.screenX + bx;
    oy = window.screenY + (window.outerHeight - window.innerHeight) - bx;
    kx = vw / screen.width;
    ky = vh / screen.height;
  } else {
    kx = vw / window.innerWidth;
    ky = vh / window.innerHeight;
  }
  let sx = (ox + r.left) * kx;
  let sy = (oy + r.top) * ky;
  let sw = r.width * kx;
  let sh = r.height * ky;
  // stay inside the video
  const x2 = Math.min(vw, sx + sw);
  const y2 = Math.min(vh, sy + sh);
  sx = Math.max(0, sx);
  sy = Math.max(0, sy);
  sw = x2 - sx;
  sh = y2 - sy;
  return sw < 2 || sh < 2 ? null : { sx, sy, sw, sh };
}

function waitFrames(v, n) {
  return new Promise((resolve) => {
    let left = n;
    const guard = setTimeout(resolve, 900);
    const step = () => {
      if (--left <= 0) {
        clearTimeout(guard);
        resolve();
      } else if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(step);
      else setTimeout(step, 50);
    };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(step);
    else setTimeout(step, 100);
  });
}

const pad2 = (n) => String(n).padStart(2, "0");
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;
}
function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// getTarget() → { el, frameW, frameH, radius, name } for the phone that should be recorded.
export function useRecorder({ getTarget }) {
  const targetRef = useRef(getTarget);
  targetRef.current = getTarget;
  const [state, setStateRaw] = useState("idle"); // idle | starting | countdown | recording | saving
  const [count, setCount] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [toast, setToast] = useState(null);
  const stRef = useRef("idle");
  const S = useRef(null);
  const stopRef = useRef(() => Promise.resolve());

  const setState = useCallback((s) => {
    stRef.current = s;
    setStateRaw(s);
  }, []);
  const say = useCallback(
    (kind, text) => setToast({ kind, text, id: Date.now() }),
    [],
  );
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(
      () => setToast(null),
      toast.kind === "bad" ? 9000 : 6500,
    );
    return () => clearTimeout(t);
  }, [toast]);

  const teardown = useCallback(() => {
    const s = S.current;
    document.documentElement.classList.remove("is-recording");
    if (!s) return;
    S.current = null;
    cancelAnimationFrame(s.raf);
    clearInterval(s.timer);
    s.stream?.getTracks().forEach((t) => t.stop());
    if (s.video) {
      s.video.srcObject = null;
      s.video.remove();
    }
  }, []);

  const stop = useCallback(() => {
    const s = S.current;
    const st = stRef.current;
    if (!s) return Promise.resolve();
    if (st === "starting") {
      s.cancelled = true; // the picker is still open; cleaned up when it returns
      return Promise.resolve();
    }
    if (st === "countdown") {
      teardown();
      setState("idle");
      return Promise.resolve();
    }
    if (st !== "recording") return Promise.resolve();
    setState("saving");
    cancelAnimationFrame(s.raf);
    return new Promise((resolve) => {
      s.resolveStop = resolve;
      try {
        s.rec.stop();
      } catch {
        s.finalize();
      }
    });
  }, [teardown, setState]);
  stopRef.current = stop;

  const start = useCallback(async () => {
    if (stRef.current !== "idle") return;
    const tg0 = targetRef.current?.();
    if (!tg0?.el) {
      say("bad", "Open a simulator first, then press Record.");
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      say("bad", "Screen capture is not available in this window.");
      return;
    }
    const cfg = readRec();
    const s = { cancelled: false };
    S.current = s;
    setState("starting");
    const fail = (msg) => {
      teardown();
      setState("idle");
      say("bad", msg);
    };
    const gone = () => S.current !== s;

    try {
      // 1 ─ ask for the screen (the browser may show its own picker the first time)
      let stream;
      const hint = cfg.fps === "auto" ? 60 : Number(cfg.fps);
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: hint, max: 60 }, cursor: "never" },
          audio: false,
          preferCurrentTab: true,
          selfBrowserSurface: "include",
          surfaceSwitching: "exclude",
        });
      } catch (e) {
        if (e?.name === "TypeError")
          stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
          });
        else throw e;
      }
      s.stream = stream;
      if (s.cancelled) {
        teardown();
        setState("idle");
        return;
      }
      const track = stream.getVideoTracks()[0];
      const surface = track.getSettings?.().displaySurface || "browser";
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.srcObject = stream;
      Object.assign(v.style, {
        position: "fixed",
        left: "-9999px",
        top: "0",
        width: "2px",
        height: "2px",
        opacity: "0",
        pointerEvents: "none",
      });
      document.body.appendChild(v);
      s.video = v;
      await v.play();

      // 2 ─ exact crop of the phone when the browser supports Region Capture, else a computed one
      let cropped = false;
      if (surface === "browser" && window.CropTarget && track.cropTo) {
        try {
          await track.cropTo(await window.CropTarget.fromElement(tg0.el));
          cropped = true;
        } catch {
          /* fall back to the computed crop */
        }
      }
      await waitFrames(v, cropped ? 3 : 2);
      if (gone()) return;

      const tg = targetRef.current?.();
      const src = tg?.el && sourceRect(v, surface, cropped, tg.el);
      if (!src) return fail("Could not find the simulator on screen.");
      const srcScale = src.sw / tg.frameW; // real captured pixels per phone point

      // 3 ─ plan: resolution, fps, bitrate, codec
      const plan = makePlan(cfg, tg.frameW, tg.frameH, srcScale);
      const mime = pickMime(!plan.bg);
      if (!mime) return fail("This window cannot encode video.");
      const canvas = document.createElement("canvas");
      canvas.width = plan.W;
      canvas.height = plan.H;
      const ctx = canvas.getContext("2d", { alpha: !plan.bg });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      let L = buildLayout(
        plan.W,
        plan.H,
        tg.frameW,
        tg.frameH,
        tg.radius,
        plan.bg,
      );

      const draw = () => {
        const t = targetRef.current?.();
        if (!t?.el) return;
        const sr = sourceRect(v, surface, cropped, t.el);
        if (!sr) return; // phone hidden for a moment: keep the last frame
        if (L.fw !== t.frameW || L.fh !== t.frameH)
          L = buildLayout(
            plan.W,
            plan.H,
            t.frameW,
            t.frameH,
            t.radius,
            plan.bg,
          ); // rotated
        if (L.bg) ctx.drawImage(L.bg, 0, 0);
        else ctx.clearRect(0, 0, plan.W, plan.H);
        ctx.save();
        ctx.clip(L.clip);
        ctx.drawImage(v, sr.sx, sr.sy, sr.sw, sr.sh, L.dx, L.dy, L.dw, L.dh);
        ctx.restore();
        s.vtrack.requestFrame?.();
      };

      // 4 ─ 3-2-1, so you can get ready
      setState("countdown");
      for (let n = 3; n > 0; n--) {
        setCount(n);
        await new Promise((r) => setTimeout(r, 1000));
        if (gone()) return;
      }

      // 5 ─ encode the canvas; frames are pushed only when drawn (paced to the chosen fps)
      const cstream = canvas.captureStream(0);
      s.vtrack = cstream.getVideoTracks()[0];
      if (!s.vtrack.requestFrame) {
        s.vtrack = canvas.captureStream(plan.fps).getVideoTracks()[0];
      }
      const rec = new MediaRecorder(cstream, {
        mimeType: mime,
        videoBitsPerSecond: plan.bps,
      });
      const chunks = [];
      rec.ondataavailable = (e) => e.data?.size && chunks.push(e.data);
      rec.onerror = () => fail("Recording failed.");
      s.rec = rec;
      s.finalize = () => {
        const type = (rec.mimeType || mime).split(";")[0];
        const blob = new Blob(chunks, { type });
        const name = `AppPeek-${(tg.name || "iPhone").replace(/\s+/g, "-")}${plan.bg ? "" : "-nobg"}-${stamp()}.${type.includes("mp4") ? "mp4" : "webm"}`;
        const upscaled = L.k / srcScale > 1.15;
        const resolve = s.resolveStop;
        teardown();
        if (blob.size) {
          download(blob, name);
          say(
            "ok",
            `Saved ${name} · ${plan.W}×${plan.H} · ${plan.fps} fps · ${(blob.size / 1048576).toFixed(1)} MB` +
              (upscaled
                ? ". The screen was smaller than the video, so enlarge the simulator for a sharper result."
                : ""),
          );
        } else say("bad", "Nothing was recorded.");
        setState("idle");
        resolve?.();
      };
      rec.onstop = s.finalize;
      track.addEventListener("ended", () => stopRef.current()); // "Stop sharing"

      draw();
      rec.start(1000);
      s.t0 = performance.now();
      setElapsed(0);
      setState("recording");
      document.documentElement.classList.add("is-recording");
      s.timer = setInterval(() => {
        const e = (performance.now() - s.t0) / 1000;
        setElapsed(e);
        if (e >= MAX_SECONDS) stopRef.current();
      }, 250);

      const interval = 1000 / plan.fps;
      let next = performance.now();
      const tick = (t) => {
        s.raf = requestAnimationFrame(tick);
        if (t + 1 < next) return; // not due yet (display refresh faster than the video fps)
        next = Math.max(next + interval, t);
        draw();
      };
      s.raf = requestAnimationFrame(tick);
    } catch (e) {
      teardown();
      setState("idle");
      if (e?.name === "NotAllowedError" || e?.name === "AbortError")
        say("info", "Screen capture was cancelled or not allowed.");
      else
        say(
          "bad",
          `Could not start recording${e?.message ? `: ${e.message}` : "."}`,
        );
    }
  }, [teardown, setState, say]);

  const toggle = useCallback(() => {
    if (stRef.current === "idle") start();
    else if (stRef.current === "countdown" || stRef.current === "recording")
      stopRef.current();
  }, [start]);

  // closing the screen while recording still saves what was captured
  useEffect(
    () => () => {
      if (stRef.current === "recording") stopRef.current();
      else teardown();
    },
    [teardown],
  );

  return {
    state,
    count,
    elapsed,
    toast,
    dismiss: () => setToast(null),
    start,
    stop,
    toggle,
    isActive: () => stRef.current !== "idle",
  };
}
