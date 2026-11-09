import { useState } from "react";
import { Delete, Globe, ArrowBigUp } from "lucide-react";

const LETTERS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const SYMBOLS = ["1234567890", '-/:;()$&@"', ".,?!'"];

function Key({ children, className = "", grow = 1, onClick, label }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      className={`vkb-key ${className}`}
      style={{ flexGrow: grow }}
      onClick={onClick}
      aria-label={label}
    >
      {children}
    </button>
  );
}

// iOS-style on-screen keyboard preview. It is a visual simulation: keys are typed into the
// focused field of your app, but it is not Apple's keyboard (no suggestions, emoji or dictation).
// `height` includes the bottom safe area, so the keys stop above the home indicator.
export default function VirtualKeyboard({
  open,
  height,
  bottomInset,
  layout,
  decimal,
  returnLabel,
  onKey,
  onDone,
}) {
  const [shift, setShift] = useState(false);
  const [sym, setSym] = useState(false);

  const press = (k) => onKey(k);
  const letter = (ch) => {
    onKey(shift ? ch.toUpperCase() : ch);
    if (shift) setShift(false);
  };
  const pad = layout === "number";
  const rows = sym ? SYMBOLS : LETTERS;

  return (
    <div
      className={`vkb ${open ? "is-open" : ""}`}
      style={{ height, "--vkb-bottom": `${bottomInset}px` }}
      onMouseDown={(e) => e.preventDefault()} // keep focus in the app's input
      aria-hidden={!open}
    >
      <div className="vkb-bar">
        <span className="vkb-sug" />
        <span className="vkb-sug" />
        <span className="vkb-sug" />
        <button
          type="button"
          tabIndex={-1}
          className="vkb-done"
          onClick={onDone}
        >
          Done
        </button>
      </div>

      <div className="vkb-keys">
        {pad ? (
          <>
            {[
              ["1", "2", "3"],
              ["4", "5", "6"],
              ["7", "8", "9"],
            ].map((r) => (
              <div className="vkb-row" key={r[0]}>
                {r.map((k) => (
                  <Key key={k} onClick={() => press(k)}>
                    {k}
                  </Key>
                ))}
              </div>
            ))}
            <div className="vkb-row">
              <Key
                className={decimal ? "" : "ghost"}
                onClick={() => decimal && press(".")}
              >
                {decimal ? "." : ""}
              </Key>
              <Key onClick={() => press("0")}>0</Key>
              <Key
                className="fn"
                label="Delete"
                onClick={() => press("Backspace")}
              >
                <Delete size={20} />
              </Key>
            </div>
          </>
        ) : (
          <>
            <div className="vkb-row">
              {rows[0].split("").map((c) => (
                <Key key={c} onClick={() => (sym ? press(c) : letter(c))}>
                  {sym || !shift ? c : c.toUpperCase()}
                </Key>
              ))}
            </div>
            <div className="vkb-row vkb-row-mid">
              {rows[1].split("").map((c) => (
                <Key key={c} onClick={() => (sym ? press(c) : letter(c))}>
                  {sym || !shift ? c : c.toUpperCase()}
                </Key>
              ))}
            </div>
            <div className="vkb-row">
              {sym ? (
                <Key className="fn" grow={1.4} onClick={() => {}}>
                  #+=
                </Key>
              ) : (
                <Key
                  className={`fn ${shift ? "on" : ""}`}
                  grow={1.4}
                  label="Shift"
                  onClick={() => setShift((s) => !s)}
                >
                  <ArrowBigUp size={20} />
                </Key>
              )}
              {rows[2].split("").map((c) => (
                <Key key={c} onClick={() => (sym ? press(c) : letter(c))}>
                  {sym || !shift ? c : c.toUpperCase()}
                </Key>
              ))}
              <Key
                className="fn"
                grow={1.4}
                label="Delete"
                onClick={() => press("Backspace")}
              >
                <Delete size={20} />
              </Key>
            </div>
            <div className="vkb-row">
              <Key className="fn" grow={1.3} onClick={() => setSym((v) => !v)}>
                {sym ? "ABC" : "123"}
              </Key>
              <Key className="fn" label="Keyboards" onClick={() => {}}>
                <Globe size={18} />
              </Key>
              <Key grow={4.2} label="Space" onClick={() => press(" ")}>
                <span className="vkb-space">space</span>
              </Key>
              <Key className="fn ret" grow={1.9} onClick={() => press("Enter")}>
                {returnLabel}
              </Key>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
