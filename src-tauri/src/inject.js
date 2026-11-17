/* MobileLab preview helper. The backend injects this into the Expo page's HTML.
   It never changes your components: it only (1) tells the page its iPhone safe-area / keyboard
   sizes through CSS variables, (2) reports focus + top colour to MobileLab, (3) types keys sent
   from the on-screen keyboard, and (4) when Layout Inspector is on, measures what sits in the
   protected system areas and reports it. Overlays are drawn by MobileLab, not inside your page. */
(function () {
  var root = document.documentElement;
  var timer = 0;
  var lastTheme = "";
  var lastIssues = "";
  var kb = { visible: false, height: 0, resize: false };
  var insp = { on: false, zones: [] };
  var vv = window.visualViewport;
  var vvOffset = 0;
  var optStyle = document.getElementById("ml-opt");

  function post(msg) {
    try {
      parent.postMessage(msg, "*");
    } catch (e) {}
  }
  function px(name, v) {
    root.style.setProperty(name, (v || 0) + "px");
  }

  /* ── 1. safe-area insets (the page's CSS env() lookups are rewritten to read these variables) ── */
  function setSafe(s) {
    s = s || {};
    px("--ml-inset-top", s.top);
    px("--ml-inset-right", s.right);
    px("--ml-inset-bottom", s.bottom);
    px("--ml-inset-left", s.left);
  }

  var u = new URL(location.href);
  var m = /mlsafe=(\d+),(\d+),(\d+),(\d+)/.exec(u.hash);
  var v = null;
  var dirty = false;
  if (m) {
    v = { top: +m[1], right: +m[2], bottom: +m[3], left: +m[4] };
    try {
      sessionStorage.setItem("mlsafe", JSON.stringify(v));
    } catch (e) {}
    dirty = true;
  } else {
    try {
      v = JSON.parse(sessionStorage.getItem("mlsafe"));
    } catch (e) {}
  }
  if (u.searchParams.has("mlr")) {
    u.searchParams.delete("mlr");
    dirty = true;
  }
  if (dirty) {
    u.hash = "";
    try {
      history.replaceState(null, "", u.pathname + u.search);
    } catch (e) {}
  }
  if (v) setSafe(v);

  /* ── 1a. re-measure insets. react-native-safe-area-context (web) reads the insets from a hidden
        zero-size <div> once at mount, and again only when a CSS transition event fires on it.
        Fire that event ourselves so headers pick up the real values at start-up and whenever the
        device or orientation changes (no reload needed). ── */
  function nudgeInsets() {
    var kids = document.body ? document.body.children : [];
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (el.tagName !== "DIV") continue;
      var cs = getComputedStyle(el);
      if (
        cs.visibility === "hidden" &&
        el.offsetWidth === 0 &&
        /^(fixed|absolute)$/.test(cs.position)
      ) {
        ["transitionend", "webkitTransitionEnd", "transitionEnd"].forEach(
          function (n) {
            try {
              el.dispatchEvent(new Event(n));
            } catch (e) {}
          },
        );
      }
    }
  }
  function remeasure() {
    nudgeInsets();
    try {
      window.dispatchEvent(
        new Event("resize"),
      ); /* safe-area-context 5.x listens to this too */
    } catch (e) {}
  }
  /* the bundle can take a while to mount the app, so re-measure a few times */
  [300, 1000, 2500, 5000].forEach(function (ms) {
    setTimeout(remeasure, ms);
  });

  /* ── 1b. styles set from JavaScript. react-native-safe-area-context builds its CSS value at run time
        (the pieces "env", "(safe-area-inset-" and the side are joined in code), so the text rewrite done by
        the proxy cannot see it. Rewrite the value at the moment it is assigned instead. ── */
  var ENV_FIX = /(?:env|constant)\(\s*safe-area-inset-/g;
  var KB_FIX = /env\(\s*keyboard-inset-/g;
  function fixCss(val) {
    if (typeof val !== "string" || val.indexOf("-inset-") < 0) return val;
    return val
      .replace(ENV_FIX, "var(--ml-inset-")
      .replace(KB_FIX, "var(--ml-kb-");
  }
  try {
    var proto = CSSStyleDeclaration.prototype;
    var origSet = proto.setProperty;
    proto.setProperty = function (name, val, pri) {
      return origSet.call(this, name, fixCss(val), pri);
    };
    [
      "padding",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "margin",
      "marginTop",
      "marginRight",
      "marginBottom",
      "marginLeft",
      "top",
      "right",
      "bottom",
      "left",
      "width",
      "height",
      "minHeight",
      "maxHeight",
      "minWidth",
      "maxWidth",
      "cssText",
    ].forEach(function (name) {
      var dsc = null;
      for (var o = proto; o && !dsc; o = Object.getPrototypeOf(o))
        dsc = Object.getOwnPropertyDescriptor(o, name);
      if (!dsc || !dsc.set) return;
      Object.defineProperty(proto, name, {
        configurable: true,
        enumerable: dsc.enumerable,
        get: dsc.get,
        set: function (val) {
          dsc.set.call(this, fixCss(val));
        },
      });
    });
    var origInsert = CSSStyleSheet.prototype.insertRule;
    CSSStyleSheet.prototype.insertRule = function (rule, index) {
      return origInsert.call(this, fixCss(rule), index);
    };
  } catch (e) {}

  /* ── 1c. THE reliable path. In Chromium, `element.style.paddingTop = "env(safe-area-inset-top)"` cannot be
        intercepted through CSSStyleDeclaration.prototype (the properties are not accessors on the prototype),
        so the setter patch above never sees it. react-native-safe-area-context and React DOM both assign styles
        exactly that way. The assignment always ends up in the element's style ATTRIBUTE, so rewrite it there. ── */
  function fixStyleAttr(el) {
    if (!el || el.nodeType !== 1 || !el.getAttribute) return false;
    var a = el.getAttribute("style");
    if (!a || a.indexOf("-inset-") < 0) return false;
    var b = fixCss(a);
    if (b === a) return false;
    el.setAttribute("style", b);
    return true;
  }
  try {
    new MutationObserver(function (records) {
      var changed = false;
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === "attributes") {
          if (fixStyleAttr(r.target)) changed = true;
        } else {
          for (var j = 0; j < r.addedNodes.length; j++) {
            var n = r.addedNodes[j];
            if (n.nodeType !== 1) continue;
            if (fixStyleAttr(n)) changed = true;
            if (n.querySelectorAll) {
              var list = n.querySelectorAll('[style*="-inset-"]');
              for (var k = 0; k < list.length; k++)
                if (fixStyleAttr(list[k])) changed = true;
            }
          }
        }
      }
      if (changed) {
        setTimeout(remeasure, 0);
        setTimeout(remeasure, 80);
      }
    }).observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["style"],
    });
  } catch (e) {}

  /* ── 2. options: iOS-style scrolling, reduced motion (test) ── */
  var CSS_SCROLL =
    "html,body{overscroll-behavior:none}*{-webkit-tap-highlight-color:transparent}";
  /* Always on: no browser focus ring / box on inputs (your app draws its own focus state), and no
     native widget chrome, so TextInput looks the same as on a real iPhone. */
  var CSS_BASE =
    /* iOS has no visible scrollbars. !important + html/body/* so neither the page nor a ScrollView can show one;
       always on (not tied to the scroll option). Scrolling itself is untouched. */
    "html,body,*{scrollbar-width:none!important;-ms-overflow-style:none!important}" +
    "::-webkit-scrollbar,*::-webkit-scrollbar{display:none!important;width:0!important;height:0!important;background:transparent!important}" +
    "input,textarea,select,[contenteditable],[role=textbox]{outline:none!important;outline-width:0!important;-webkit-appearance:none;appearance:none}" +
    "input:focus,input:focus-visible,textarea:focus,textarea:focus-visible,[contenteditable]:focus,[contenteditable]:focus-visible,[role=textbox]:focus{outline:none!important}" +
    "*:focus,*:focus-visible{outline:none!important}" +
    "input::-ms-reveal,input::-ms-clear,input::-webkit-credentials-auto-fill-button{display:none!important}" +
    /* Like a real phone: static text, images and buttons cannot be selected or long-press-copied,
       while text fields (TextInput) stay fully selectable and editable. */
    "html,body,*{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}" +
    "input,textarea,[contenteditable],[contenteditable] *,[role=textbox]{-webkit-user-select:text!important;user-select:text!important}" +
    "img,svg,a{-webkit-user-drag:none!important}";
  var CSS_MOTION =
    "*,*::before,*::after{animation-duration:.001ms!important;animation-delay:0s!important;transition-duration:.001ms!important;transition-delay:0s!important;scroll-behavior:auto!important}";
  function setOptions(o) {
    o = o || {};
    if (optStyle)
      optStyle.textContent =
        CSS_BASE +
        (o.scroll !== false ? CSS_SCROLL : "") +
        (o.reduceMotion ? CSS_MOTION : "");
  }
  setOptions({ scroll: true });

  /* ── 2b. no text selection / copy / context menu outside text fields (mobile behaviour).
        CSS above handles normal cases; these events cover Ctrl+A, Ctrl+C, drag-select,
        right-click and dragging images or links. ── */
  function inField(t) {
    for (
      var el = t && t.nodeType === 3 ? t.parentElement : t;
      el;
      el = el.parentElement
    ) {
      if (el.nodeType === 1 && isEditable(el)) return true;
    }
    return false;
  }
  function clearSelection() {
    try {
      var s = window.getSelection && window.getSelection();
      if (
        s &&
        s.rangeCount &&
        !inField(document.activeElement) &&
        !selectable(s.anchorNode)
      )
        s.removeAllRanges();
    } catch (e) {}
  }
  /* Text the developer made selectable (RN `selectable` / userSelect: "text") computes to
     user-select:text because RN-web's class beats our zero-specificity default; leave it alone. */
  function selectable(t) {
    try {
      var el = t && t.nodeType === 3 ? t.parentElement : t;
      if (!el || el.nodeType !== 1) return false;
      var cs = getComputedStyle(el);
      var us = cs.userSelect || cs.webkitUserSelect;
      return us === "text" || us === "all";
    } catch (e) {
      return false;
    }
  }
  addEventListener(
    "selectstart",
    function (e) {
      if (!inField(e.target) && !selectable(e.target)) e.preventDefault();
    },
    true,
  );
  addEventListener(
    "contextmenu",
    function (e) {
      e.preventDefault();
    },
    true,
  );
  addEventListener(
    "dragstart",
    function (e) {
      if (!inField(e.target)) e.preventDefault();
    },
    true,
  );
  ["copy", "cut"].forEach(function (n) {
    addEventListener(
      n,
      function (e) {
        if (
          !inField(document.activeElement) &&
          !selectable(getSelection().anchorNode)
        )
          e.preventDefault();
      },
      true,
    );
  });
  addEventListener(
    "keydown",
    function (e) {
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        var k = String(e.key).toLowerCase();
        if (
          (k === "a" || k === "c" || k === "x") &&
          !inField(document.activeElement)
        )
          e.preventDefault();
      }
    },
    true,
  );
  addEventListener("mouseup", clearSelection, true);
  addEventListener("dblclick", clearSelection, true);

  /* ── 3. keyboard: CSS variables + a visualViewport that shrinks like Safari's ── */
  if (vv) {
    try {
      var d = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(vv),
        "height",
      );
      Object.defineProperty(vv, "height", {
        configurable: true,
        get: function () {
          var base = d && d.get ? d.get.call(vv) : innerHeight;
          return Math.max(0, base - vvOffset);
        },
      });
    } catch (e) {}
  }

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    var t = el.tagName;
    if (t === "TEXTAREA") return !el.readOnly && !el.disabled;
    if (t === "INPUT")
      return (
        !el.readOnly &&
        !el.disabled &&
        !/^(button|checkbox|radio|submit|reset|file|image|range|color|hidden)$/i.test(
          el.type,
        )
      );
    return !!el.isContentEditable || el.getAttribute("role") === "textbox";
  }

  function revealFocused() {
    var el = document.activeElement;
    if (!kb.visible || !isEditable(el)) return;
    if (kb.resize) {
      try {
        el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      } catch (e) {}
      return;
    }
    var r = el.getBoundingClientRect();
    var limit = innerHeight - kb.height - 12;
    if (r.bottom <= limit) return;
    var by = r.bottom - limit;
    for (var p = el.parentElement; p && p !== root; p = p.parentElement) {
      var cs = getComputedStyle(p);
      if (
        /(auto|scroll)/.test(cs.overflowY) &&
        p.scrollHeight > p.clientHeight + 1
      ) {
        p.scrollBy({ top: by, behavior: "smooth" });
        return;
      }
    }
    if (
      document.scrollingElement &&
      document.scrollingElement.scrollHeight > innerHeight
    )
      window.scrollBy({ top: by, behavior: "smooth" });
  }

  function setKeyboard(k) {
    k = k || {};
    kb = {
      visible: !!k.visible,
      height: k.visible ? k.height || 0 : 0,
      resize: !!k.resize,
    };
    var h = kb.visible && !kb.resize ? kb.height : 0; // in resize mode the page itself is shorter
    px("--ml-kb-height", h);
    px("--ml-kb-width", innerWidth);
    px("--ml-kb-top", h ? innerHeight - h : 0);
    vvOffset = h;
    if (vv) {
      try {
        vv.dispatchEvent(new Event("resize"));
      } catch (e) {}
    }
    if (kb.visible) setTimeout(revealFocused, 280);
    soon();
  }

  /* ── focus reporting (so MobileLab can show/hide its keyboard) ── */
  function reportFocus() {
    var el = document.activeElement;
    var ok = isEditable(el);
    var mode = "text";
    var decimal = false;
    var hint = "";
    if (ok) {
      var im = String(el.inputMode || "").toLowerCase();
      var ty = String(el.type || "").toLowerCase();
      if (/^(numeric|decimal|tel)$/.test(im) || ty === "number" || ty === "tel")
        mode = "number";
      decimal =
        im === "decimal" ||
        (ty === "number" && /[.]|any/.test(String(el.step || "")));
      hint = String(
        el.enterKeyHint || el.getAttribute("enterkeyhint") || "",
      ).toLowerCase();
    }
    post({
      type: "mobilelab:focus",
      editable: ok,
      mode: mode,
      decimal: decimal,
      hint: hint,
    });
  }
  addEventListener("focusin", reportFocus, true);
  addEventListener(
    "focusout",
    function () {
      setTimeout(reportFocus, 50);
    },
    true,
  );

  /* ── typing from MobileLab's on-screen keyboard ── */
  function keyEvent(type, key) {
    var code =
      key === "Enter"
        ? 13
        : key === "Backspace"
          ? 8
          : key.length === 1
            ? key.toUpperCase().charCodeAt(0)
            : 0;
    return new KeyboardEvent(type, {
      key: key,
      bubbles: true,
      cancelable: true,
      keyCode: code,
      which: code,
    });
  }
  function typeKey(key) {
    var el = document.activeElement;
    if (!isEditable(el)) return;
    var go = el.dispatchEvent(keyEvent("keydown", key));
    if (go) {
      if (key === "Backspace") document.execCommand("delete");
      else if (key === "Enter") {
        if (
          el.tagName === "TEXTAREA" ||
          (el.isContentEditable &&
            el.getAttribute("aria-multiline") !== "false")
        )
          document.execCommand("insertText", false, "\n");
      } else document.execCommand("insertText", false, key);
    }
    el.dispatchEvent(keyEvent("keyup", key));
  }

  /* ── 4. layout inspector ── */
  var SKIP =
    /^(SCRIPT|STYLE|LINK|META|NOSCRIPT|HEAD|TITLE|BR|HR|PATH|G|DEFS|CIRCLE|RECT|LINE|POLYGON|POLYLINE|ELLIPSE|USE|SYMBOL|CLIPPATH|MASK|LINEARGRADIENT|RADIALGRADIENT|STOP|TSPAN)$/i;
  var BOXES = /^(IMG|SVG|VIDEO|CANVAS|INPUT|TEXTAREA|SELECT|BUTTON)$/i;

  function ownText(el) {
    for (var n = el.firstChild; n; n = n.nextSibling)
      if (n.nodeType === 3 && /\S/.test(n.nodeValue)) return n;
    return null;
  }
  function contentRects(el) {
    var tn = ownText(el);
    var out = [];
    if (tn) {
      try {
        var rg = document.createRange();
        rg.selectNodeContents(tn);
        var list = rg.getClientRects();
        for (var i = 0; i < list.length; i++) out.push(list[i]);
      } catch (e) {}
      if (!out.length) out.push(el.getBoundingClientRect());
    } else if (
      BOXES.test(el.tagName) ||
      el.getAttribute("role") === "button" ||
      el.getAttribute("role") === "textbox"
    ) {
      out.push(el.getBoundingClientRect());
    }
    return out;
  }
  function overlap(r, z) {
    var w = Math.min(r.left + r.width, z.x + z.w) - Math.max(r.left, z.x);
    var h = Math.min(r.top + r.height, z.y + z.h) - Math.max(r.top, z.y);
    return w > 0 && h > 0 ? { w: w, h: h } : null;
  }
  function shown(el) {
    for (
      var p = el, n = 0;
      p && p !== root && n < 14;
      p = p.parentElement, n++
    ) {
      var cs = getComputedStyle(p);
      if (
        cs.display === "none" ||
        parseFloat(cs.opacity) <= 0.01 ||
        (n === 0 && cs.visibility === "hidden")
      )
        return false;
    }
    return true;
  }
  function isPinned(el) {
    for (
      var p = el, n = 0;
      p && p !== root && n < 14;
      p = p.parentElement, n++
    ) {
      var pos = getComputedStyle(p).position;
      if (pos === "fixed" || pos === "sticky" || pos === "absolute")
        return true;
    }
    return false;
  }
  function isScrolled(el) {
    if ((window.scrollY || 0) > 0) return true;
    for (var p = el.parentElement; p && p !== root; p = p.parentElement)
      if (p.scrollTop > 0) return true;
    return false;
  }
  function labelFor(kind, pinned) {
    if (kind === "status")
      return pinned
        ? "Fixed header sits under the status bar"
        : "Content overlaps the status bar area";
    if (kind === "island") return "Content is behind the Dynamic Island";
    if (kind === "notch") return "Content is behind the notch";
    if (kind === "home")
      return pinned
        ? "Bottom bar overlaps the home indicator area"
        : "Content overlaps the home indicator area";
    if (kind === "side") return "Content is inside the landscape side inset";
    return "Input is covered by the keyboard";
  }

  function scan() {
    if (!insp.on || !document.body) return;
    var zones = insp.zones || [];
    var issues = [];
    var seen = {};
    var all = document.body.getElementsByTagName("*");
    for (var i = 0; i < all.length && issues.length < 14; i++) {
      var el = all[i];
      if (SKIP.test(el.tagName)) continue;
      var rects = contentRects(el);
      if (!rects.length) continue;
      var info = null; // computed lazily, only for elements that actually touch a zone
      for (var j = 0; j < rects.length; j++) {
        var r = rects[j];
        if (r.width < 2 || r.height < 2) continue;
        for (var k = 0; k < zones.length; k++) {
          var z = zones[k];
          if (z.kind === "keyboard" && !isEditable(el)) continue;
          var o = overlap(r, z);
          if (
            !o ||
            o.w < 2 ||
            o.h < 2 ||
            (z.kind !== "keyboard" && o.w * o.h < 24)
          )
            continue;
          if (!info)
            info = shown(el)
              ? { pinned: isPinned(el), scrolled: isScrolled(el) }
              : { hidden: true };
          if (info.hidden) break;
          if (info.scrolled && !info.pinned) continue; // content that was scrolled there is normal
          var key =
            z.kind +
            "|" +
            Math.round(r.left) +
            "|" +
            Math.round(r.top) +
            "|" +
            Math.round(r.width) +
            "|" +
            Math.round(r.height);
          if (seen[key]) continue;
          seen[key] = 1;
          issues.push({
            kind: z.kind,
            label: labelFor(z.kind, info.pinned),
            x: r.left,
            y: r.top,
            w: r.width,
            h: r.height,
          });
          break; // zones are ordered most specific first (island/notch before the status band)
        }
        if (info && info.hidden) break;
      }
    }
    var sig = JSON.stringify(issues);
    if (sig !== lastIssues) {
      lastIssues = sig;
      post({ type: "mobilelab:issues", issues: issues });
    }
  }

  /* ── top colour (status bar text) ── */
  function bg(el) {
    while (el) {
      var c = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
      if (c && (c.length < 4 || parseFloat(c[3]) > 0.5)) return c.map(Number);
      el = el.parentElement;
    }
    return [255, 255, 255];
  }
  function sampleTheme() {
    try {
      var w = Math.max(innerWidth, 1);
      var ys = [4, 12, 20];
      var xs = [0.15, 0.5, 0.85];
      var sum = [0, 0, 0];
      var n = 0;
      for (var yi = 0; yi < ys.length; yi++) {
        for (var xi = 0; xi < xs.length; xi++) {
          var el =
            document.elementFromPoint(
              Math.max(1, Math.min(w - 2, w * xs[xi])),
              ys[yi],
            ) || document.body;
          var p = bg(el);
          sum[0] += p[0];
          sum[1] += p[1];
          sum[2] += p[2];
          n++;
        }
      }
      if (!n) return;
      var r = sum[0] / n;
      var g = sum[1] / n;
      var b = sum[2] / n;
      var dark = 0.299 * r + 0.587 * g + 0.114 * b < 150;
      var key =
        (dark ? "d" : "l") +
        Math.round(r) +
        "," +
        Math.round(g) +
        "," +
        Math.round(b);
      if (key !== lastTheme) {
        lastTheme = key;
        post({ type: "mobilelab:theme", dark: dark });
      }
    } catch (e) {}
  }

  /* One light, throttled pass for everything that measures (never runs while nothing changes). */
  function soon() {
    if (timer) return;
    timer = setTimeout(function () {
      timer = 0;
      sampleTheme();
      try {
        scan();
      } catch (e) {}
    }, 450);
  }

  addEventListener("message", function (e) {
    var d = e.data || {};
    if (e.source !== parent) return;
    if (d.type === "mobilelab:viewport") {
      setSafe(d.safe);
      setTimeout(remeasure, 0);
      setTimeout(remeasure, 120);
      soon();
    } else if (d.type === "mobilelab:options") setOptions(d);
    else if (d.type === "mobilelab:keyboard") setKeyboard(d);
    else if (d.type === "mobilelab:inspect") {
      insp = { on: !!d.on, zones: d.zones || [] };
      if (!insp.on) {
        lastIssues = "";
        post({ type: "mobilelab:issues", issues: [] });
      }
      soon();
    } else if (d.type === "mobilelab:key") typeKey(String(d.key));
    else if (d.type === "mobilelab:blur") {
      if (document.activeElement && document.activeElement.blur)
        document.activeElement.blur();
    }
  });

  /* ── 5. in-app error reporting ── */
  var lastErrKey = "";
  var lastErrAt = 0;
  function reportError(payload) {
    if (!payload || !payload.message) return;
    var key =
      (payload.name || "") +
      "|" +
      String(payload.message).slice(0, 120) +
      "|" +
      String(payload.file || "").slice(-80) +
      "|" +
      (payload.line || 0);
    var now = Date.now();
    if (key === lastErrKey && now - lastErrAt < 1500) return;
    lastErrKey = key;
    lastErrAt = now;
    post({
      type: "mobilelab:error",
      name: payload.name || "Error",
      message: String(payload.message).slice(0, 800),
      stack: payload.stack ? String(payload.stack).slice(0, 6000) : "",
      file: payload.file || "",
      line: payload.line || 0,
      column: payload.column || 0,
      source: payload.source || "runtime",
    });
  }
  function parseStack(stack) {
    if (!stack) return { file: "", line: 0, column: 0 };
    var m =
      /(?:at\s+)?(?:.*?\s+\()?((?:https?|file|webpack|metro)[^\s:)]+):(\d+):(\d+)/.exec(
        stack,
      );
    if (!m)
      m = /((?:\/|\w:)[^\s:)]+\.(?:js|tsx?|jsx?)):(\d+):(\d+)/.exec(stack);
    if (!m) return { file: "", line: 0, column: 0 };
    var file = m[1];
    try {
      var u = new URL(file, location.href);
      file = u.pathname.replace(/^\/+/, "") || file;
    } catch (e) {}
    return { file: file, line: +m[2] || 0, column: +m[3] || 0 };
  }
  function fromErrorEvent(ev) {
    var err = ev.error || ev.reason;
    var msg =
      (err && err.message) ||
      (typeof ev.message === "string" ? ev.message : "") ||
      (typeof ev.reason === "string" ? ev.reason : "") ||
      "Unknown error";
    var stack = (err && err.stack) || "";
    var loc = parseStack(stack);
    if (!loc.file && ev.filename) {
      loc.file = String(ev.filename).replace(/^.*\//, "");
      loc.line = ev.lineno || 0;
      loc.column = ev.colno || 0;
    }
    return {
      name:
        (err && err.name) ||
        (ev.type === "unhandledrejection" ? "Unhandled Rejection" : "Error"),
      message: msg,
      stack: stack,
      file: loc.file,
      line: loc.line,
      column: loc.column,
      source: ev.type === "unhandledrejection" ? "promise" : "runtime",
    };
  }
  addEventListener(
    "error",
    function (ev) {
      if (ev.target && ev.target !== window && ev.target.nodeName) return;
      reportError(fromErrorEvent(ev));
    },
    true,
  );
  addEventListener(
    "unhandledrejection",
    function (ev) {
      reportError(fromErrorEvent(ev));
    },
    true,
  );
  function scanMetroErrorPage() {
    try {
      var body = document.body;
      if (!body) return;
      var t = (body.innerText || body.textContent || "").trim();
      if (t.length < 20 || t.length > 12000) return;
      if (
        !/unable to resolve module|syntaxerror|referenceerror|typeerror|module not found|bundling failed|failed to compile|invariant violation|element type is invalid|cannot find module|metro|react native/i.test(
          t,
        )
      )
        return;
      var titleEl =
        body.querySelector("h1, h2, [data-error], pre, code") || body;
      var title = (titleEl.innerText || titleEl.textContent || "")
        .trim()
        .split("\n")[0]
        .slice(0, 200);
      var stackMatch = t.match(/(?:at\s+.+\n){1,20}/);
      reportError({
        name: "Bundle / Runtime Error",
        message: title || t.slice(0, 300),
        stack: stackMatch ? stackMatch[0] : t.slice(0, 4000),
        file: "",
        line: 0,
        column: 0,
        source: "metro",
      });
    } catch (e) {}
  }
  setTimeout(scanMetroErrorPage, 600);
  setTimeout(scanMetroErrorPage, 2000);

  /* ── first-paint gate: MobileLab keeps its loading cover until the app's own text is final, so you
        never see the fallback font swap to the custom font (useFonts / expo-font) on screen. We wait for
        document.fonts to be idle and for the DOM to stop gaining nodes. Only childList/characterData are
        watched, so a running animation can never hold the gate open. ── */
  var gateSent = false;
  var gateTimer = 0;
  function gateCheck() {
    gateTimer = 0;
    if (gateSent) return;
    var f = document.fonts;
    if (f && f.status === "loading") return; /* "loadingdone" re-arms us */
    gateSent = true;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        post({ type: "mobilelab:painted" });
      });
    });
  }
  function gateArm() {
    if (gateSent) return;
    clearTimeout(gateTimer);
    gateTimer = setTimeout(gateCheck, 250);
  }
  try {
    new MutationObserver(gateArm).observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    if (document.fonts && document.fonts.addEventListener) {
      document.fonts.addEventListener("loading", gateArm);
      document.fonts.addEventListener("loadingdone", gateArm);
    }
  } catch (e) {}
  gateArm();

  new MutationObserver(soon).observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["style", "class"],
  });
  addEventListener("scroll", soon, true);
  addEventListener("load", function () {
    setTimeout(remeasure, 0);
    soon();
  });
  addEventListener("resize", soon);
  soon();
  post({ type: "mobilelab:ready" });
})();
