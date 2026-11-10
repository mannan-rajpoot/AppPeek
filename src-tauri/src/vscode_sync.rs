// VS Code Sync: follows the minimize / restore / close state of ONE selected VS Code window
// and hides or shows the floating simulator to match. The Expo server and the floating
// window's page are never touched, so Fast Refresh keeps running the whole time.
//
// Windows only. The few user32 calls needed are declared directly (no extra crates).
// On other platforms the feature reports itself as unsupported and does nothing.

use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};
#[allow(unused_imports)]
use tauri::{AppHandle, Emitter, Manager};

/* ───────────── pure logic (unit-tested on any OS) ───────────── */

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WinState {
    Restored,
    Minimized, // iconic or hidden
    Closed,
}

// How well a VS Code window title matches the project folder. VS Code titles look like
// "App.js - my-project - Visual Studio Code"; the folder is one " - " separated segment.
pub fn title_score(title: &str, folder: &str) -> u8 {
    let folder = folder.trim().to_lowercase();
    if folder.is_empty() {
        return 0;
    }
    let t = title.to_lowercase();
    if t.split(" - ").any(|seg| seg.trim().trim_start_matches('●').trim() == folder) {
        2
    } else if t.contains(&folder) {
        1
    } else {
        0
    }
}

pub fn is_vscode_exe(name: &str) -> bool {
    matches!(
        name.to_lowercase().as_str(),
        "code.exe" | "code - insiders.exe" | "vscodium.exe" | "codium.exe"
    )
}

// Chromium creates helper windows inside Code.exe (IME, tooltips…); real editor windows
// have a real title.
pub fn is_editor_title(title: &str) -> bool {
    let t = title.trim();
    !t.is_empty() && t != "Default IME" && !t.starts_with("MSCTFIME")
}

// A candidate window: (handle, title). `list` must be in Z-order (topmost first), which is
// what EnumWindows returns. Picks the folder match first; otherwise the only window; otherwise
// the one that was most recently in front.
pub fn pick_window(list: &[(isize, String)], folder: &str) -> Option<isize> {
    let best = list
        .iter()
        .map(|(h, t)| (*h, title_score(t, folder)))
        .filter(|(_, s)| *s > 0)
        .max_by_key(|(_, s)| *s); // max_by_key keeps the LAST max, so prefer first explicitly below
    if let Some((_, top)) = best {
        return list.iter().find(|(_, t)| title_score(t, folder) == top).map(|(h, _)| *h);
    }
    list.first().map(|(h, _)| *h)
}

// Turns raw polls into transitions: a new state must be seen twice in a row (no flicker
// from a window animating or briefly changing), and only a CHANGE produces an action.
pub struct Debounce {
    stable: Option<WinState>,
    pending: Option<WinState>,
    seen: u8,
}

impl Debounce {
    pub fn new() -> Self {
        Self { stable: None, pending: None, seen: 0 }
    }
    // Returns Some((previous, new)) when the stable state changed.
    pub fn feed(&mut self, now: WinState) -> Option<(Option<WinState>, WinState)> {
        if Some(now) == self.stable {
            self.pending = None;
            self.seen = 0;
            return None;
        }
        if self.stable.is_none() {
            self.stable = Some(now); // first reading: just learn it, never act on it
            return None;
        }
        if self.pending == Some(now) {
            self.seen += 1;
        } else {
            self.pending = Some(now);
            self.seen = 1;
        }
        // Closed is final enough to confirm quickly; minimize/restore wait for two polls.
        if self.seen >= 2 {
            let prev = self.stable;
            self.stable = Some(now);
            self.pending = None;
            self.seen = 0;
            return Some((prev, now));
        }
        None
    }
}

/* ───────────── events to the UI ───────────── */

#[derive(Serialize, Clone)]
pub struct SyncPayload {
    // off | searching | following | minimized | closed | unsupported
    pub state: &'static str,
}

fn emit(app: &AppHandle, state: &'static str) {
    let _ = app.emit("vscode-sync", SyncPayload { state });
}

/* ───────────── handle owned by AppState ───────────── */

pub struct SyncHandle {
    stop: Arc<AtomicBool>,
}

impl Drop for SyncHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst); // the thread notices, restores the window and exits
    }
}

pub fn supported() -> bool {
    cfg!(windows)
}

/* ───────────── Windows implementation ───────────── */

#[cfg(windows)]
mod win {
    use super::*;
    use std::ffi::c_void;

    type Hwnd = isize;
    type Bool = i32;

    #[link(name = "user32")]
    extern "system" {
        fn EnumWindows(cb: unsafe extern "system" fn(Hwnd, isize) -> Bool, lparam: isize) -> Bool;
        fn IsWindow(h: Hwnd) -> Bool;
        fn IsWindowVisible(h: Hwnd) -> Bool;
        fn IsIconic(h: Hwnd) -> Bool;
        fn GetWindowTextLengthW(h: Hwnd) -> i32;
        fn GetWindowTextW(h: Hwnd, buf: *mut u16, max: i32) -> i32;
        fn GetWindowThreadProcessId(h: Hwnd, pid: *mut u32) -> u32;
        fn GetWindow(h: Hwnd, cmd: u32) -> Hwnd;
        fn GetWindowLongW(h: Hwnd, index: i32) -> i32;
        fn ShowWindow(h: Hwnd, cmd: i32) -> Bool;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: Bool, pid: u32) -> *mut c_void;
        fn CloseHandle(h: *mut c_void) -> Bool;
        fn QueryFullProcessImageNameW(p: *mut c_void, flags: u32, buf: *mut u16, size: *mut u32) -> Bool;
    }

    const GW_OWNER: u32 = 4;
    const GWL_EXSTYLE: i32 = -20;
    const WS_EX_TOOLWINDOW: i32 = 0x0000_0080;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const SW_HIDE: i32 = 0;
    const SW_SHOWNOACTIVATE: i32 = 4; // show without taking focus or changing the Z-order's active window

    fn title_of(h: Hwnd) -> String {
        unsafe {
            let n = GetWindowTextLengthW(h);
            if n <= 0 {
                return String::new();
            }
            let mut buf = vec![0u16; n as usize + 1];
            let got = GetWindowTextW(h, buf.as_mut_ptr(), buf.len() as i32);
            String::from_utf16_lossy(&buf[..got.max(0) as usize])
        }
    }

    fn exe_name(h: Hwnd) -> Option<String> {
        unsafe {
            let mut pid = 0u32;
            GetWindowThreadProcessId(h, &mut pid);
            if pid == 0 {
                return None;
            }
            let p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if p.is_null() {
                return None; // e.g. an elevated process we may not inspect
            }
            let mut buf = vec![0u16; 1024];
            let mut size = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(p, 0, buf.as_mut_ptr(), &mut size);
            CloseHandle(p);
            if ok == 0 {
                return None;
            }
            let full = String::from_utf16_lossy(&buf[..size as usize]);
            full.rsplit(['\\', '/']).next().map(|s| s.to_string())
        }
    }

    unsafe extern "system" fn collect(h: Hwnd, lparam: isize) -> Bool {
        let out = &mut *(lparam as *mut Vec<(Hwnd, String)>);
        // Cheap checks first; the process lookup only runs for plausible editor windows.
        if IsWindowVisible(h) == 0 || GetWindow(h, GW_OWNER) != 0 {
            return 1;
        }
        if GetWindowLongW(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW != 0 {
            return 1;
        }
        let title = title_of(h);
        if !is_editor_title(&title) {
            return 1;
        }
        if exe_name(h).map(|n| is_vscode_exe(&n)).unwrap_or(false) {
            out.push((h, title));
        }
        1 // keep enumerating
    }

    // All VS Code editor windows, topmost first.
    pub fn list_vscode() -> Vec<(Hwnd, String)> {
        let mut out: Vec<(Hwnd, String)> = Vec::new();
        unsafe {
            EnumWindows(collect, &mut out as *mut _ as isize);
        }
        out
    }

    pub fn state_of(h: Hwnd) -> WinState {
        unsafe {
            if IsWindow(h) == 0 {
                WinState::Closed
            } else if IsIconic(h) != 0 || IsWindowVisible(h) == 0 {
                WinState::Minimized
            } else {
                WinState::Restored
            }
        }
    }

    pub fn show_no_activate(h: Hwnd) {
        unsafe {
            ShowWindow(h, SW_SHOWNOACTIVATE);
        }
    }

    pub fn hide(h: Hwnd) {
        unsafe {
            ShowWindow(h, SW_HIDE);
        }
    }

    pub fn is_visible(h: Hwnd) -> bool {
        unsafe { IsWindowVisible(h) != 0 }
    }

    // The floating window's native handle, if it exists.
    pub fn floating_hwnd(app: &AppHandle) -> Option<Hwnd> {
        let w = app.get_webview_window("floating")?;
        w.hwnd().ok().map(|h| h.0 as isize) // works whether HWND wraps a pointer or an integer
    }

    // Win32 show/hide must run on the thread that owns the window.
    pub fn on_ui(app: &AppHandle, f: impl FnOnce() + Send + 'static) {
        let _ = app.run_on_main_thread(f);
    }

    pub fn start(app: AppHandle, folder: String) -> SyncHandle {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        thread::spawn(move || run(app, folder, flag));
        SyncHandle { stop }
    }

    fn run(app: AppHandle, folder: String, stop: Arc<AtomicBool>) {
        let mut bound: Option<Hwnd> = None;
        let mut deb = Debounce::new();
        let mut hidden_by_sync = false; // we hid the floating window, so only we may show it again
        let mut last_ui: &'static str = "";
        let mut gone_ticks = 0u32;

        let say = |s: &'static str, last: &mut &'static str| {
            if *last != s {
                *last = s;
                emit(&app, s);
            }
        };

        // Brings the floating window back if we were the ones who hid it.
        let restore_if_hidden = |hidden: &mut bool| {
            if *hidden {
                *hidden = false;
                if let Some(fh) = floating_hwnd(&app) {
                    on_ui(&app, move || show_no_activate(fh));
                }
            }
        };

        while !stop.load(Ordering::SeqCst) {
            let floating = floating_hwnd(&app);
            // Gentle when nothing is floating; responsive when it is.
            thread::sleep(Duration::from_millis(if floating.is_some() { 250 } else { 800 }));
            if stop.load(Ordering::SeqCst) {
                break;
            }

            // 1. Find the window to follow (project folder first), until we have one.
            if bound.is_none() {
                let list = list_vscode();
                // Only auto-bind to something we can justify: a folder match, or the only window.
                let has_match = list.iter().any(|(_, t)| title_score(t, &folder) > 0);
                if has_match || list.len() == 1 {
                    bound = pick_window(&list, &folder);
                    deb = Debounce::new();
                    gone_ticks = 0;
                }
                if bound.is_none() {
                    say("searching", &mut last_ui);
                    continue;
                }
            }
            let h = bound.unwrap();

            // 2. Read its real state and turn it into transitions.
            let now = state_of(h);
            let change = deb.feed(now);
            match now {
                WinState::Closed => {} // reported once, below, when the change is confirmed
                WinState::Minimized => say("minimized", &mut last_ui),
                WinState::Restored => say("following", &mut last_ui),
            }

            // 3. Act only on a confirmed change, and only on a floating window that exists.
            if let Some((_, to)) = change {
                match to {
                    WinState::Minimized => {
                        if let Some(fh) = floating {
                            if is_visible(fh) {
                                hidden_by_sync = true;
                                on_ui(&app, move || hide(fh));
                            }
                        }
                    }
                    WinState::Restored => restore_if_hidden(&mut hidden_by_sync),
                    WinState::Closed => {
                        // Leave floating mode the normal way so the dashboard returns with its
                        // state (the page asks the backend itself, keeping orientation). If the
                        // page cannot answer, the fallback below removes the window.
                        restore_if_hidden(&mut hidden_by_sync);
                        gone_ticks = 1;
                        let _ = app.emit("vscode-sync", SyncPayload { state: "closed" });
                        bound = None; // look for the project's window again if VS Code reopens
                    }
                }
            }

            // Fallback: the floating page did not leave on its own after a closed VS Code.
            if gone_ticks > 0 {
                if floating.is_some() {
                    gone_ticks += 1;
                    if gone_ticks > 8 {
                        gone_ticks = 0;
                        if let Some(w) = app.get_webview_window("floating") {
                            let _ = w.destroy(); // window-event handler brings the dashboard back
                        }
                    }
                } else {
                    gone_ticks = 0;
                }
            }

            // The floating window vanished by itself (manual exit): forget our hide flag.
            if floating.is_none() {
                hidden_by_sync = false;
            }
        }

        // Disabled or AppPeek closing: never leave the simulator hidden behind.
        restore_if_hidden(&mut hidden_by_sync);
        emit(&app, "off");
    }
}

/* ───────────── public entry points ───────────── */

#[cfg(windows)]
pub fn start(app: AppHandle, folder: String) -> Option<SyncHandle> {
    Some(win::start(app, folder))
}

#[cfg(not(windows))]
pub fn start(app: AppHandle, _folder: String) -> Option<SyncHandle> {
    emit(&app, "unsupported");
    None
}

/* ───────────── tests (cargo test) ───────────── */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scores_titles_by_folder_segment() {
        assert_eq!(title_score("App.js - my-app - Visual Studio Code", "my-app"), 2);
        assert_eq!(title_score("● App.js - My-App - Visual Studio Code", "my-app"), 2);
        assert_eq!(title_score("my-app - Visual Studio Code", "MY-APP"), 2);
        assert_eq!(title_score("my-app-old.js - other - Visual Studio Code", "my-app"), 1);
        assert_eq!(title_score("a - other - Visual Studio Code", "my-app"), 0);
        assert_eq!(title_score("anything", ""), 0);
    }

    #[test]
    fn recognises_vscode_processes_and_editor_titles() {
        assert!(is_vscode_exe("Code.exe"));
        assert!(is_vscode_exe("Code - Insiders.exe"));
        assert!(!is_vscode_exe("chrome.exe"));
        assert!(is_editor_title("App.js - app - Visual Studio Code"));
        assert!(!is_editor_title(""));
        assert!(!is_editor_title("Default IME"));
    }

    #[test]
    fn picks_the_right_window() {
        let l = vec![
            (1, "a.js - other - Visual Studio Code".to_string()),
            (2, "App.js - mine - Visual Studio Code".to_string()),
            (3, "b.js - mine - Visual Studio Code".to_string()),
        ];
        assert_eq!(pick_window(&l, "mine"), Some(2)); // folder match, topmost of the matches
        assert_eq!(pick_window(&l, "nope"), Some(1)); // no match: most recently in front
        assert_eq!(pick_window(&[], "mine"), None);
    }

    #[test]
    fn debounce_confirms_changes_and_ignores_the_first_reading() {
        use WinState::*;
        let mut d = Debounce::new();
        assert_eq!(d.feed(Minimized), None); // first reading is learned, not acted on
        assert_eq!(d.feed(Minimized), None);
        assert_eq!(d.feed(Restored), None); // needs a second reading
        assert_eq!(d.feed(Restored), Some((Some(Minimized), Restored)));
        assert_eq!(d.feed(Restored), None);
        // a one-poll blip never fires
        assert_eq!(d.feed(Minimized), None);
        assert_eq!(d.feed(Restored), None);
        assert_eq!(d.feed(Minimized), None);
        assert_eq!(d.feed(Minimized), Some((Some(Restored), Minimized)));
        assert_eq!(d.feed(Closed), None);
        assert_eq!(d.feed(Closed), Some((Some(Minimized), Closed)));
    }
}