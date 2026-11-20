import { useCallback, useEffect, useRef, useState } from "react";
import { createCursor } from "./recCursor.js";

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
  fps: 60,
  bg: true,
  sharp: true, // enlarge the phone to the biggest size that fits while recording, then restore it
  cursor: true, // draw a smooth macOS-style cursor into the video (the system cursor is left out)
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
  { v: "native", label: "1080×1920 native HD (60 fps)" },
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
  { v: 60, label: "60 fps (needs 8 GB RAM)" },
  { v: 30, label: "30 fps (steady, recommended)" },
];

const ASPECT = { "1:1": 1, "4:5": 0.8, "9:16": 9 / 16 }; // width / height
const PAD = 0.055; // empty margin around the phone, as a share of the canvas
const NATIVE = { W: 1080, H: 1920, pad: 0.035 }; // exact 1080×1920 story canvas, phone fills it
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
// Every encoder this window supports, best first (the recorder tries them in order).
export function pickMimes(alpha = false) {
  if (typeof MediaRecorder === "undefined") return [];
  return (alpha ? ALPHA_MIME_LIST : MIME_LIST).filter((m) =>
    MediaRecorder.isTypeSupported(m),
  );
}
export function pickMime(alpha = false) {
  return pickMimes(alpha)[0] || null;
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

const hw = () => {
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4;
  const strong = cores >= 8 && mem >= 8;
  // Only caps "Auto" to protect weak encoders; downscaling keeps text clean, upscaling blurs it.
  const capLong = strong ? 2160 : cores >= 4 ? 1920 : 1440;
  return { cores, strong, capLong };
};
// Low-memory PCs (under 6 GB, e.g. 4 GB) cannot hold 60 fps: the encoder stalls and frames come out
// uneven. They are held at an even 30 fps whatever is selected. 8 GB or more can use 60.
export const lowMemory = () => (navigator.deviceMemory || 8) < 6;
export function planFps(cfg) {
  if (lowMemory()) return 30;
  return cfg.size === "native" || Number(cfg.fps) === 60 ? 60 : 30;
}

// Output canvas for the chosen options. Returns null when "Auto" needs the captured size first.
function sizing(cfg, frameW, frameH, srcScale) {
  const { capLong } = hw();
  if (cfg.size === "native")
    return { W: NATIVE.W, H: NATIVE.H, bg: true, pad: NATIVE.pad };
  const auto = cfg.size === "auto";
  if (auto && srcScale == null) return null;
  if (cfg.bg === false) {
    // phone only: the video has the phone's own proportions, "resolution" is its long side
    const long = Math.max(frameW, frameH);
    const L = auto
      ? Math.max(480, Math.min(Math.round(srcScale * long), capLong))
      : Number(cfg.size);
    const k = L / long;
    return { W: even(frameW * k), H: even(frameH * k), bg: false, pad: 0 };
  }
  const r = ASPECT[cfg.aspect] || 1;
  let short;
  if (auto) {
    const wanted = (srcScale * Math.max(frameW, frameH * r)) / (1 - 2 * PAD);
    short = Math.max(
      480,
      Math.min(Math.round(wanted), capLong * Math.min(1, r)),
    );
  } else short = Number(cfg.size);
  return { W: even(short), H: even(short / r), bg: true, pad: PAD };
}

// Output pixels per phone point the chosen options need (0 = "Auto", which just matches the screen).
// The simulator is enlarged on screen to this size while recording, so the pixels are real, not stretched.
export function targetK(cfg, frameW, frameH) {
  const z = sizing(cfg, frameW, frameH, null);
  if (!z) return 0;
  return Math.min(
    (z.W * (1 - 2 * z.pad)) / frameW,
    (z.H * (1 - 2 * z.pad)) / frameH,
  );
}

// Resolution / frame-rate / bitrate for this recording. "Auto" matches the real pixels that are
// on screen (never blows a small capture up).
export function makePlan(cfg, frameW, frameH, srcScale) {
  const fps = planFps(cfg);
  const z = sizing(cfg, frameW, frameH, srcScale);
  // ~0.3 bits per pixel per frame keeps thin text strokes free of H.264 blur (37 Mbps at 1080×1920@60).
  const bps = Math.round(Math.min(60e6, Math.max(8e6, z.W * z.H * fps * 0.3)));
  return { ...z, fps, bps };
}

// Wait until the page has really re-laid-out and re-painted (e.g. after the phone was enlarged).
const settle = (ms = 450) =>
  new Promise((resolve) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => setTimeout(resolve, ms)),
    ),
  );

// Static part of every frame: white background + soft shadow (falls to the right, like the
// reference clip), the rounded clip path and where the phone goes. Built once, not per frame.
function buildLayout(
  W,
  H,
  frameW,
  frameH,
  radius,
  withBg = true,
  snap = null,
  padding = PAD,
) {
  const pad = withBg ? padding : 0;
  const k = Math.min(
    (W * (1 - 2 * pad)) / frameW,
    (H * (1 - 2 * pad)) / frameH,
  );
  // Whole pixels only: a half-pixel offset or size makes the canvas resample every glyph (blur).
  // When the target is within 2 px of the captured size, use the captured size exactly (1:1).
  let dw = Math.round(frameW * k);
  let dh = Math.round(frameH * k);
  if (snap && Math.abs(dw - snap.sw) <= 2 && Math.abs(dh - snap.sh) <= 2) {
    dw = Math.round(snap.sw);
    dh = Math.round(snap.sh);
  }
  const dx = Math.round((W - dw) / 2);
  const dy = Math.round((H - dh) / 2);
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
  // whole source pixels, so a 1:1 copy is a true pixel copy
  sx = Math.round(sx);
  sy = Math.round(sy);
  sw = Math.round(sw);
  sh = Math.round(sh);
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

// ───────── Auto-adjust: pick the best resolution + frame rate this laptop can really record ─────────
// Records short synthetic clips (same canvas drawing, same encoder, same bitrate as a real recording)
// from the best setting downwards and keeps the first one that holds its frame rate without stalls.
// Only "size" and "fps" are changed; every other option (sharp text, background, shape, cursor) is kept.
const TUNE_LADDER = [
  [2160, 60],
  [1440, 60],
  [1080, 60],
  [1440, 30],
  [1080, 30],
  [720, 60],
  [720, 30],
];
const sizeLabel = (n) =>
  n === 2160
    ? "2160p 4K"
    : n === 1440
      ? "1440p 2K"
      : n === 1080
        ? "1080p Full HD"
        : `${n}p`;

async function benchOne(cfg, size, fps, ms = 1500) {
  const NOM = { w: 430, h: 932, r: 55 }; // a typical phone frame
  const z = sizing({ ...cfg, size }, NOM.w, NOM.h, 1);
  const mimes = pickMimes(!z.bg);
  if (!mimes.length) return false;
  const L = buildLayout(z.W, z.H, NOM.w, NOM.h, NOM.r, z.bg, null, z.pad);
  const canvas = document.createElement("canvas");
  canvas.width = z.W;
  canvas.height = z.H;
  const ctx = canvas.getContext("2d", { alpha: !z.bg });
  // a UI-like source: white page with text-like bars
  const page = document.createElement("canvas");
  page.width = L.dw;
  page.height = L.dh;
  const px = page.getContext("2d");
  px.fillStyle = "#fff";
  px.fillRect(0, 0, L.dw, L.dh);
  for (let i = 0; i < 60; i++) {
    px.fillStyle = i % 7 === 0 ? "#0a0a0a" : "#d8d8d8";
    px.fillRect(
      L.dw * 0.1,
      L.dh * (0.05 + i * 0.015),
      L.dw * (0.25 + ((i * 37) % 50) / 100),
      L.dh * 0.006,
    );
  }
  let cstream = canvas.captureStream(0);
  let vt = cstream.getVideoTracks()[0];
  if (!vt.requestFrame) {
    cstream = canvas.captureStream(fps);
    vt = cstream.getVideoTracks()[0];
  }
  try {
    vt.contentHint = "detail";
  } catch {
    /* optional */
  }
  const bps = Math.round(Math.min(60e6, Math.max(8e6, z.W * z.H * fps * 0.3)));
  let rec = null;
  for (const m of mimes) {
    try {
      rec = new MediaRecorder(cstream, {
        mimeType: m,
        videoBitsPerSecond: bps,
      });
      break;
    } catch {
      /* next encoder */
    }
  }
  if (!rec) {
    cstream.getTracks().forEach((t) => t.stop());
    return false;
  }
  let bytes = 0;
  let failed = false;
  rec.ondataavailable = (e) => (bytes += e.data?.size || 0);
  rec.onerror = () => (failed = true);
  const stamps = [];
  let raf = 0;
  const t0 = performance.now();
  const interval = 1000 / fps;
  let next = t0;
  const tick = (t) => {
    raf = requestAnimationFrame(tick);
    if (t + interval * 0.3 < next) return;
    next = Math.max(next + interval, t);
    const k = (t - t0) / 1000;
    if (L.bg) ctx.drawImage(L.bg, 0, 0);
    else ctx.clearRect(0, 0, z.W, z.H);
    ctx.save();
    ctx.clip(L.clip);
    ctx.drawImage(page, L.dx, L.dy);
    // moving content so the encoder has real work every frame
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(L.dx, L.dy + ((k * 0.35) % 1) * L.dh * 0.8, L.dw, L.dh * 0.14);
    ctx.fillStyle = "rgba(120,120,120,0.45)";
    ctx.fillRect(
      L.dx + ((k * 0.6) % 1) * L.dw * 0.7,
      L.dy + L.dh * 0.3,
      L.dw * 0.3,
      L.dh * 0.3,
    );
    ctx.restore();
    vt.requestFrame?.();
    stamps.push(performance.now());
  };
  try {
    rec.start(500);
    raf = requestAnimationFrame(tick);
    await sleep(ms);
  } catch {
    failed = true;
  }
  cancelAnimationFrame(raf);
  await new Promise((resolve) => {
    const guard = setTimeout(resolve, 2500);
    rec.onstop = () => {
      clearTimeout(guard);
      resolve();
    };
    try {
      rec.stop();
    } catch {
      clearTimeout(guard);
      resolve();
    }
  });
  cstream.getTracks().forEach((t) => t.stop());
  if (failed || !bytes) return false;

  const body = stamps.filter((t) => t - t0 > 400); // ignore the warm-up
  if (body.length < 8) return false;
  const span = body[body.length - 1] - body[0];
  const gaps = body
    .slice(1)
    .map((t, i) => t - body[i])
    .sort((a, b) => a - b);
  const p95 = gaps[Math.floor(gaps.length * 0.95)];
  const achieved = ((body.length - 1) / span) * 1000;
  return achieved >= fps * 0.93 && p95 <= interval * 1.8;
}

// Largest output the screen can fill with real pixels (phone ≈ screen height minus the app's own bars).
function tuneCap(cfg, size) {
  const dpr = window.devicePixelRatio || 1;
  const avail = (window.screen.availHeight || window.innerHeight || 900) * dpr;
  const room = Math.max(400 * dpr, avail - 140 * dpr);
  const z = sizing({ ...cfg, size }, 430, 932, 1);
  return z.H * (1 - 2 * z.pad) <= room * 1.35; // a little enlarging is fine, a lot only blurs
}

export async function autoTune(onStep) {
  const cfg = readRec();
  const low = lowMemory();
  const ladder = TUNE_LADDER.filter(
    ([size, fps]) => (!low || fps === 30) && tuneCap(cfg, size),
  );
  const list = ladder.length ? ladder : [[720, 30]];
  let pick = list[list.length - 1];
  for (let i = 0; i < list.length; i++) {
    const [size, fps] = list[i];
    onStep?.(`Testing ${sizeLabel(size)} · ${fps} fps…`);
    await settle(120);
    let ok = false;
    try {
      ok = i === list.length - 1 ? true : await benchOne(cfg, size, fps);
    } catch {
      ok = false;
    }
    if (ok) {
      pick = list[i];
      break;
    }
  }
  const [size, fps] = pick;
  writeRec({ ...readRec(), size, fps }); // sharp text and every other option stay as they are
  return { size, fps, label: `${sizeLabel(size)} · ${fps} fps` };
}

// getTarget() → { el, frameW, frameH, radius, name } for the phone that should be recorded.
// prepare() (optional) runs before capture starts: it may enlarge the phone for a sharper video and
// returns a function that puts everything back, called when the recording ends or is cancelled.
export function useRecorder({ getTarget, prepare }) {
  const targetRef = useRef(getTarget);
  targetRef.current = getTarget;
  const prepareRef = useRef(prepare);
  prepareRef.current = prepare;
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
    try {
      s.restore?.(); // put the phone size back
    } catch {
      /* ignore */
    }
    try {
      s.cursor?.stop();
    } catch {
      /* ignore */
    }
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
      // 0 ─ sharp mode: make the phone as large as the window allows (restored when we finish)
      if (cfg.sharp !== false && prepareRef.current) {
        try {
          const need = targetK(cfg, tg0.frameW, tg0.frameH);
          s.restore = (await prepareRef.current({ need })) || null;
          if (s.restore) await settle();
        } catch {
          /* recording still works at the current size */
        }
        if (s.cancelled || gone()) {
          teardown();
          setState("idle");
          return;
        }
      }

      // 1 ─ ask for the screen (the browser may show its own picker the first time)
      let stream;
      // Ask the capture for 60 when we can: sampling a 30 fps video from a 60 fps source is smoother.
      const hint = lowMemory() ? 30 : 60;
      // The system cursor is never wanted in the capture: when it is on, a virtual cursor is drawn
      // instead (smooth, macOS style). Some windows reject the richer requests with a TypeError, and
      // the old plain fallback silently brought the system cursor back, so every fallback keeps
      // `cursor: "never"` and it is applied again on the live track below.
      const gdm = (opts) => navigator.mediaDevices.getDisplayMedia(opts);
      const attempts = [
        () =>
          gdm({
            // Ask for the full native pixels (no capture-side downscale) and a 60 fps source.
            video: {
              frameRate: { ideal: hint, max: 60 },
              width: { ideal: 3840 },
              height: { ideal: 2160 },
              cursor: "never",
            },
            audio: false,
            preferCurrentTab: true,
            selfBrowserSurface: "include",
            surfaceSwitching: "exclude",
          }),
        () =>
          gdm({
            video: {
              frameRate: { ideal: hint, max: 60 },
              width: { ideal: 3840 },
              height: { ideal: 2160 },
              cursor: "never",
            },
            audio: false,
          }),
        () => gdm({ video: { cursor: "never" }, audio: false }),
        () => gdm({ video: true }),
      ];
      for (let i = 0; i < attempts.length; i++) {
        try {
          stream = await attempts[i]();
          break;
        } catch (e) {
          if (e?.name !== "TypeError" || i === attempts.length - 1) throw e;
        }
      }
      s.stream = stream;
      if (s.cancelled) {
        teardown();
        setState("idle");
        return;
      }
      const track = stream.getVideoTracks()[0];
      const virtualCursor = cfg.cursor !== false;
      if (virtualCursor) {
        try {
          await track.applyConstraints({ cursor: "never" });
        } catch {
          /* not supported by this window: the settings check below tells */
        }
      }
      try {
        track.contentHint = "detail"; // tell the pipeline sharp text matters more than motion
      } catch {
        /* optional */
      }
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
      const mimes = pickMimes(!plan.bg);
      if (!mimes.length) return fail("This window cannot encode video.");
      const canvas = document.createElement("canvas");
      canvas.width = plan.W;
      canvas.height = plan.H;
      const ctx = canvas.getContext("2d", { alpha: !plan.bg });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      // macOS cursor: a real on-screen element (the capture records it). It needs the system cursor to be
      // invisible: the phone page confirms it hides its own cursor (inject.js), or the capture leaves it out.
      if (virtualCursor) {
        const cur = createCursor(() => targetRef.current?.());
        const hidden = await cur.ready;
        if (hidden || track.getSettings?.().cursor === "never") {
          cur.enable();
          s.cursor = cur;
        } else {
          cur.stop();
          s.cursorNote =
            " · Windows cursor recorded as is: restart AppPeek once so the updated preview helper (inject.js) loads";
        }
        if (gone()) {
          cur.stop();
          return;
        }
      }
      let L = buildLayout(
        plan.W,
        plan.H,
        tg.frameW,
        tg.frameH,
        tg.radius,
        plan.bg,
        src,
        plan.pad,
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
            sr,
            plan.pad,
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
      try {
        s.vtrack.contentHint = "detail";
      } catch {
        /* optional */
      }
      // Try each encoder (H.264 MP4 first) until one actually opens at this size.
      let rec = null;
      let mime = null;
      for (const m of mimes) {
        try {
          rec = new MediaRecorder(cstream, {
            mimeType: m,
            videoBitsPerSecond: plan.bps,
          });
          mime = m;
          break;
        } catch {
          /* try the next format */
        }
      }
      if (!rec) return fail("This window could not start the video encoder.");
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
        const s0 = { cursorNote: s.cursorNote }; // teardown() clears S.current
        teardown();
        if (blob.size) {
          download(blob, name);
          say(
            "ok",
            `Saved ${name} · ${plan.W}×${plan.H} · ${plan.fps} fps · ${(blob.size / 1048576).toFixed(1)} MB` +
              (type.includes("mp4") ? "" : " · WebM (no MP4 encoder here)") +
              (s0.cursorNote || "") +
              (plan.fps === 30 &&
              (cfg.size === "native" || Number(cfg.fps) === 60)
                ? " · held at 30 fps (low memory PC)"
                : "") +
              (upscaled
                ? `. The phone only had ${src.sh} real pixels in height but is ${L.dh} px tall in the video, so it was enlarged (softer). A bigger or higher-DPI display, or a smaller output size, gives a sharper result.`
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
        if (t + interval * 0.3 < next) return; // not due yet; the tolerance stops 60 fps from skipping frames on jitter
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
