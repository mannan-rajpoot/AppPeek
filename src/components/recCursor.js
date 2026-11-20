// ─────────────────────────────────────────────────────────────
//  macOS-style cursor for app UI recordings.
//
//  The screen capture in this window always records the Windows cursor, whatever it is asked, and
//  nothing drawn on the video can remove it. So while recording:
//    1. the Windows cursor is made invisible: `cursor: none` here and, through the preview helper
//       (inject.js, "recording cursor"), inside the phone page too. A hidden cursor is not captured.
//    2. a macOS arrow is shown on screen in its place, as a real element above the app. The capture
//       records it like any other pixel, and you see the same cursor live while you work.
//
//  The arrow is black with a white outline and soft shadow, sized in phone points (so it keeps the same
//  proportion at any resolution). A critically damped spring glides it between mouse samples (no
//  overshoot, same at any frame rate). It presses in and sends out a soft ripple on click.
//
//  Pointer source: the phone is a cross-origin iframe, so the preview helper reports the pointer and the
//  left button from inside it (`mobilelab:pointer`); over the rest of the window plain mouse events are used.
//  No Rust, no permissions. The preview helper is compiled into the app, so restart AppPeek once after
//  updating inject.js; until then the recording falls back to the normal Windows cursor.
// ─────────────────────────────────────────────────────────────

const OMEGA_POS = 26; // spring stiffness: higher = tighter follow, lower = floatier
const OMEGA_PRESS = 42;
const OMEGA_FADE = 24;
const HEIGHT_PTS = 19; // arrow height in phone points
const RIPPLE_MS = 560;
const RIPPLE_PTS = 30; // ripple radius in phone points
const ARROW_W = 12;
const ARROW_H = 19;
// macOS arrow, tip (the click point) at 0,0
const ARROW =
  "M0.6 0.6 L0.6 16.4 L4.3 13 L6.8 19 L9.5 17.8 L7 11.9 L11.9 11.9 Z";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Exact step of a critically damped spring (stable for any dt).
function spring(s, target, omega, dt) {
  const d = s.x - target;
  const e = Math.exp(-omega * dt);
  const t = (s.v + omega * d) * dt;
  s.x = target + (d + t) * e;
  s.v = (s.v - omega * t) * e;
}

// ───────── pointer source ─────────
// Latest pointer in window CSS pixels, whether the left button is down, and whether it left the window.
function createPointerSource(onAck) {
  const p = { x: NaN, y: NaN, down: false, out: false };
  const frameOf = (win) =>
    [...document.querySelectorAll("iframe")].find(
      (f) => f.contentWindow === win,
    );

  const onMove = (e) => {
    p.x = e.clientX;
    p.y = e.clientY;
    p.out = false;
  };
  const onDown = (e) => {
    if (e.button === 0) p.down = true;
  };
  const onUp = (e) => {
    if (e.button === 0) p.down = false;
  };
  const onLeave = () => {
    p.out = true;
    p.down = false;
  };
  const onMsg = (e) => {
    const d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "mobilelab:cursor-ack") return onAck();
    if (d.type !== "mobilelab:pointer") return;
    const f = frameOf(e.source);
    if (!f) return;
    // iframe coordinates → window coordinates (the phone is scaled by CSS, its layout size is not)
    const r = f.getBoundingClientRect();
    const kx = f.offsetWidth ? r.width / f.offsetWidth : 1;
    const ky = f.offsetHeight ? r.height / f.offsetHeight : 1;
    p.x = r.left + d.x * kx;
    p.y = r.top + d.y * ky;
    p.down = !!d.down;
    p.out = false;
  };
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onUp, true);
  window.addEventListener("message", onMsg);
  document.documentElement.addEventListener("mouseleave", onLeave);

  return {
    read: () => p,
    stop() {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      window.removeEventListener("message", onMsg);
      document.documentElement.removeEventListener("mouseleave", onLeave);
    },
  };
}

// ───────── cursor ─────────
// getTarget() → { el, frameW } of the phone, so the arrow is sized relative to the phone.
// `ready` resolves true when the phone page confirmed it hides its cursor; call enable() to show the arrow.
export function createCursor(getTarget) {
  let ack = () => {};
  const acked = new Promise((r) => (ack = () => r(true)));
  const src = createPointerSource(() => ack());
  const X = { x: 0, v: 0 };
  const Y = { x: 0, v: 0 };
  const A = { x: 0, v: 0 }; // opacity
  const P = { x: 0, v: 0 }; // press
  let seen = false;
  let enabled = false;
  let last = 0;
  let wasDown = false;
  let raf = 0;
  let stopped = false;

  // overlay: never intercepts the mouse, sits above everything
  const root = document.createElement("div");
  Object.assign(root.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "0",
    height: "0",
    zIndex: "2147483647",
    pointerEvents: "none",
  });
  const cur = document.createElement("div");
  Object.assign(cur.style, {
    position: "absolute",
    left: "0",
    top: "0",
    width: `${ARROW_W}px`,
    height: `${ARROW_H}px`,
    transformOrigin: "0 0",
    willChange: "transform, opacity",
    opacity: "0",
    pointerEvents: "none",
  });
  cur.innerHTML =
    `<svg width="${ARROW_W}" height="${ARROW_H}" viewBox="0 0 ${ARROW_W} ${ARROW_H}" ` +
    `style="display:block;overflow:visible;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,0.42))">` +
    `<path d="${ARROW}" fill="#fff" stroke="#fff" stroke-width="2.6" stroke-linejoin="round"/>` +
    `<path d="${ARROW}" fill="#000"/></svg>`;
  root.appendChild(cur);
  document.body.appendChild(root);
  // the user's own cursor is hidden over the page too (the arrow replaces it)
  const css = document.createElement("style");
  css.textContent =
    "html.rec-cursor, html.rec-cursor * { cursor: none !important; }";
  document.head.appendChild(css);
  document.documentElement.classList.add("rec-cursor");

  // ask every phone page to hide its own cursor and report the pointer; the reply says the helper is new
  // enough. (Re-sent while running so a page that reloads mid-recording keeps working.)
  const broadcast = (on) =>
    document.querySelectorAll("iframe").forEach((f) => {
      try {
        f.contentWindow?.postMessage({ type: "mobilelab:cursor", on }, "*");
      } catch {
        /* cross-origin frame gone */
      }
    });
  broadcast(true);
  const keep = setInterval(() => broadcast(true), 1000);
  const ready = Promise.race([acked, sleep(600).then(() => false)]);

  function ripple(x, y, scale) {
    const R = RIPPLE_PTS * scale;
    const d = document.createElement("div");
    Object.assign(d.style, {
      position: "absolute",
      left: `${x - R}px`,
      top: `${y - R}px`,
      width: `${2 * R}px`,
      height: `${2 * R}px`,
      borderRadius: "50%",
      background: "rgba(0,0,0,0.10)",
      boxShadow: "inset 0 0 0 1.5px rgba(0,0,0,0.22)",
      pointerEvents: "none",
    });
    root.insertBefore(d, cur);
    const a = d.animate(
      [
        { transform: "scale(0.27)", opacity: 1 },
        { transform: "scale(1)", opacity: 0 },
      ],
      { duration: RIPPLE_MS, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
    a.onfinish = () => d.remove();
  }

  const frame = (now) => {
    if (stopped) return;
    raf = requestAnimationFrame(frame);
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
    last = now;
    if (!enabled) return;
    const m = src.read();
    if (!Number.isFinite(m.x)) return;

    const tg = getTarget?.();
    const rect = tg?.el?.getBoundingClientRect();
    const scale =
      rect && tg.frameW > 0
        ? Math.min(4, Math.max(0.6, rect.width / tg.frameW))
        : 1;
    const inside =
      !m.out &&
      m.x >= 0 &&
      m.y >= 0 &&
      m.x <= window.innerWidth &&
      m.y <= window.innerHeight;

    // first sample, or coming back after fading out: appear where the mouse is, no fly-in
    if (!seen || (A.x < 0.02 && inside)) {
      X.x = m.x;
      Y.x = m.y;
      X.v = Y.v = 0;
    }
    seen = true;

    spring(X, m.x, OMEGA_POS, dt);
    spring(Y, m.y, OMEGA_POS, dt);
    spring(A, inside ? 1 : 0, OMEGA_FADE, dt);
    spring(P, m.down && inside ? 1 : 0, OMEGA_PRESS, dt);
    if (m.down && !wasDown && inside) ripple(X.x, Y.x, scale);
    wasDown = m.down;

    const press = Math.min(1, Math.max(0, P.x));
    const s = (HEIGHT_PTS * scale) / ARROW_H;
    cur.style.transform = `translate3d(${X.x}px, ${Y.x}px, 0) scale(${s * (1 - 0.1 * press)})`;
    cur.style.opacity = String(Math.min(1, Math.max(0, A.x)));
  };
  raf = requestAnimationFrame(frame);

  return {
    ready,
    enable: () => {
      enabled = true;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(raf);
      src.stop();
      clearInterval(keep);
      broadcast(false);
      document.documentElement.classList.remove("rec-cursor");
      css.remove();
      root.remove();
    },
  };
}
