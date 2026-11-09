// MobileLab backend — Phase 3: project detection + Expo dev-server management.
// All process handling lives here (never in browser JavaScript).

use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    fs,
    io::{self, BufRead, BufReader, Read, Write},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, Shutdown, SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(unix)]
use std::os::unix::process::CommandExt;

const FIRST_PORT: u16 = 8081;
const LAST_PORT: u16 = 8099;
const UPSTREAM_FIRST: u16 = 8100; // Metro's own port when it sits behind the preview proxy
const UPSTREAM_LAST: u16 = 8199;
const START_TIMEOUT_SECS: u64 = 180; // slow disks / first start can take a while

/* ───────────── shared types ───────────── */

#[derive(Serialize, Debug)]
struct Problem {
    message: String,
    hint: Option<String>,
}

fn problem(message: &str, hint: &str) -> Problem {
    Problem {
        message: message.to_string(),
        hint: if hint.is_empty() { None } else { Some(hint.to_string()) },
    }
}

#[derive(Serialize, Debug)]
struct ProjectInfo {
    name: String,
    path: String,
    manager: String,
    installed: bool,
    web_missing: Vec<String>,
    warnings: Vec<String>,
}

#[derive(Serialize, Clone)]
struct ServerPayload {
    state: &'static str, // stopped | starting | running | error | lost
    url: Option<String>,
    port: Option<u16>,
    message: Option<String>,
    hint: Option<String>,
    external: bool, // true = attached to a server MobileLab did not start
}

fn payload(
    state: &'static str,
    port: Option<u16>,
    message: Option<String>,
    hint: Option<String>,
    external: bool,
) -> ServerPayload {
    ServerPayload {
        state,
        url: port.map(|p| format!("http://localhost:{p}")),
        port,
        message,
        hint,
        external,
    }
}

fn emit(app: &AppHandle, p: ServerPayload) {
    let _ = app.emit("server-state", p);
}

struct Server {
    child: Option<Child>, // None = external server we only watch
    port: u16,            // the port the preview loads (proxy, or Metro itself without a proxy)
    upstream: u16,        // the port Metro really listens on
    path: String,
    id: u64,
    #[allow(dead_code)]
    proxy: Option<Proxy>, // dropped with the server, which stops it
}

#[derive(Default)]
struct Inner {
    server: Option<Server>,
    next_id: u64,
    log: VecDeque<String>,
    float_cfg: Option<FloatCfg>,
    float_exit: Option<FloatExit>,
}

#[derive(Clone, Default)]
struct AppState(Arc<Mutex<Inner>>);

/* ───────────── small helpers ───────────── */

fn base(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(program);
    #[cfg(windows)]
    c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no flashing console
    c
}

// Windows ships npx/pnpm/yarn as .cmd shims, so go through cmd there.
fn shell(args: &[&str]) -> Command {
    if cfg!(windows) {
        let mut c = base("cmd");
        c.arg("/C").args(args);
        c
    } else {
        let mut c = base(args[0]);
        c.args(&args[1..]);
        c
    }
}

fn node_version() -> Option<String> {
    let out = base("node").arg("--version").output().ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        None
    }
}

fn norm(p: &str) -> String {
    p.trim()
        .trim_start_matches(r"\\?\")
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

fn connect_any(port: u16) -> Option<TcpStream> {
    for ip in [IpAddr::V4(Ipv4Addr::LOCALHOST), IpAddr::V6(Ipv6Addr::LOCALHOST)] {
        if let Ok(s) = TcpStream::connect_timeout(&SocketAddr::new(ip, port), Duration::from_millis(300)) {
            return Some(s);
        }
    }
    None
}

fn port_is_free(port: u16) -> bool {
    connect_any(port).is_none() && TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn find_free_port_in(a: u16, b: u16) -> Option<u16> {
    (a..=b).find(|p| port_is_free(*p))
}

fn find_free_port() -> Option<u16> {
    find_free_port_in(FIRST_PORT, LAST_PORT)
}

// Is a Metro/Expo server listening on `port`? Returns its project root when it says so.
fn probe_metro(port: u16) -> Option<String> {
    let mut s = connect_any(port)?;
    s.set_read_timeout(Some(Duration::from_millis(800))).ok()?;
    s.set_write_timeout(Some(Duration::from_millis(800))).ok()?;
    s.write_all(b"GET /status HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").ok()?;
    let mut buf = Vec::new();
    let _ = (&mut s).take(16384).read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf).to_string();
    if !text.contains("packager-status:running") {
        return None;
    }
    let root = text
        .lines()
        .find(|l| l.to_lowercase().starts_with("x-react-native-project-root:"))
        .and_then(|l| l.splitn(2, ':').nth(1))
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    Some(root)
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::new();
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\u{1b}' {
            if it.peek() == Some(&'[') {
                it.next();
                while let Some(&n) = it.peek() {
                    it.next();
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let _ = base("taskkill").args(["/PID", &child.id().to_string(), "/T", "/F"]).output();
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill").args(["-TERM", "--", &format!("-{}", child.id())]).output();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn stop_inner(st: &AppState) -> bool {
    let sv = st.0.lock().unwrap().server.take();
    match sv {
        Some(mut s) => {
            if let Some(c) = s.child.as_mut() {
                kill_tree(c);
            }
            true
        }
        None => false,
    }
}

fn explain(tail: &[String]) -> (String, String) {
    let all = tail.join("\n").to_lowercase();
    let last: String = tail
        .iter()
        .rev()
        .find(|l| l.to_lowercase().contains("error"))
        .or_else(|| tail.last())
        .cloned()
        .unwrap_or_default()
        .chars()
        .take(180)
        .collect();

    if all.contains("eaddrinuse") || all.contains("address already in use") {
        (
            "The port is already in use.".into(),
            "Another program took the port. Press Start again and MobileLab will pick a free one.".into(),
        )
    } else if all.contains("cannot find module") || all.contains("err_module_not_found") {
        (
            "A project dependency is missing.".into(),
            "Run your package manager's install command in the project folder, then press Start.".into(),
        )
    } else if all.contains("react-native-web") || all.contains("react-dom") {
        (
            "Expo Web is not set up in this project.".into(),
            "Run `npx expo install react-dom react-native-web @expo/metro-runtime`, then press Start.".into(),
        )
    } else if all.contains("is not recognized") || all.contains("command not found") || all.contains("enoent") {
        (
            "A required tool was not found.".into(),
            "Make sure Node.js and your package manager are installed, then restart MobileLab.".into(),
        )
    } else if last.is_empty() {
        (
            "Expo stopped unexpectedly.".into(),
            "Check the project in VS Code, then press Start again.".into(),
        )
    } else {
        (
            format!("Expo stopped: {last}"),
            "Check the project in VS Code, then press Start again.".into(),
        )
    }
}

/* ───────────── project detection ───────────── */

fn inspect(dir: &Path) -> Result<ProjectInfo, Problem> {
    if !dir.is_dir() {
        return Err(problem("That folder does not exist.", "Pick your Expo project folder again."));
    }
    let text = fs::read_to_string(dir.join("package.json")).map_err(|_| {
        problem(
            "No package.json found in this folder.",
            "Select the root folder of your Expo project (the one that contains package.json).",
        )
    })?;
    let pkg: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| problem("package.json is not valid JSON.", "Fix package.json in VS Code and try again."))?;
    let declared = |name: &str| {
        ["dependencies", "devDependencies"]
            .iter()
            .any(|k| pkg.get(k).and_then(|d| d.get(name)).is_some())
    };
    if !declared("expo") {
        return Err(problem(
            "This is not an Expo project.",
            "'expo' is not listed in package.json. Create a project with `npx create-expo-app`.",
        ));
    }

    let manager = if dir.join("pnpm-lock.yaml").exists() {
        "pnpm"
    } else if dir.join("yarn.lock").exists() {
        "yarn"
    } else if dir.join("package-lock.json").exists() {
        "npm"
    } else {
        match pkg.get("packageManager").and_then(|v| v.as_str()) {
            Some(s) if s.starts_with("pnpm") => "pnpm",
            Some(s) if s.starts_with("yarn") => "yarn",
            _ => "npm",
        }
    };

    let modules = dir.join("node_modules");
    let installed = modules.join("expo").exists();
    let web_missing: Vec<String> = if installed {
        ["react-dom", "react-native-web", "@expo/metro-runtime"]
            .iter()
            .filter(|m| !modules.join(m).exists())
            .map(|m| m.to_string())
            .collect()
    } else {
        vec![]
    };

    let mut warnings = vec![];
    if node_version().is_none() {
        warnings.push("Node.js was not found. Install Node.js (LTS) from nodejs.org and restart MobileLab.".to_string());
    }
    if !installed {
        warnings.push(format!("Dependencies are not installed. Run `{manager} install` in the project folder."));
    } else if !web_missing.is_empty() {
        warnings.push(format!(
            "Expo Web support is missing. Run `npx expo install {}` in the project folder.",
            web_missing.join(" ")
        ));
    }

    let name = pkg
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| dir.file_name().map(|n| n.to_string_lossy().to_string()))
        .unwrap_or_else(|| "expo-project".to_string());

    Ok(ProjectInfo {
        name,
        path: dir.to_string_lossy().to_string(),
        manager: manager.to_string(),
        installed,
        web_missing,
        warnings,
    })
}

/* ───────────── preview proxy ─────────────
   The simulator loads the Expo page through this tiny local proxy so MobileLab can:
   - give the page real iPhone safe-area / keyboard sizes (env(safe-area-inset-*) and
     env(keyboard-inset-*) become variables that MobileLab sets),
   - learn the page's top colour and focus state (status bar text, on-screen keyboard), and
   - run the optional layout inspector. It never edits your components.
   Everything else (HMR websockets, assets, API calls) passes through untouched. */

// The helper script lives in inject.js (readable, and tested separately).
const INJECT_JS: &str = include_str!("inject.js");

fn inject_block() -> String {
    format!(
        "<style id=\"ml-safe\">:root{{--ml-inset-top:0px;--ml-inset-right:0px;--ml-inset-bottom:0px;--ml-inset-left:0px;--ml-kb-top:0px;--ml-kb-right:0px;--ml-kb-bottom:0px;--ml-kb-left:0px;--ml-kb-width:0px;--ml-kb-height:0px}}</style><style id=\"ml-opt\"></style><script>{INJECT_JS}</script>"
    )
}

struct Proxy {
    port: u16,
    stop: Arc<AtomicBool>,
    wake: Vec<SocketAddr>,
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        for a in &self.wake {
            let _ = TcpStream::connect_timeout(a, Duration::from_millis(200)); // wake the accept loop
        }
    }
}

// `public`: the exact port to listen on (None = any free port). Returns None if it cannot bind.
fn start_proxy(public: Option<u16>, upstream: u16) -> Option<Proxy> {
    let v4 = TcpListener::bind(("127.0.0.1", public.unwrap_or(0))).ok()?;
    let port = v4.local_addr().ok()?.port();
    let mut listeners = vec![v4];
    if let Ok(v6) = TcpListener::bind(("::1", port)) {
        listeners.push(v6); // so http://localhost:port works whichever way it resolves
    }
    let stop = Arc::new(AtomicBool::new(false));
    let mut wake = vec![];
    for l in listeners {
        wake.push(l.local_addr().ok()?);
        let stop = stop.clone();
        thread::spawn(move || {
            for conn in l.incoming() {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                if let Ok(c) = conn {
                    thread::spawn(move || handle_conn(c, upstream));
                }
            }
        });
    }
    Some(Proxy { port, stop, wake })
}

fn find(h: &[u8], n: &[u8], from: usize) -> Option<usize> {
    if n.is_empty() || h.len() < n.len() + from {
        return None;
    }
    let last = h.len() - n.len();
    let mut i = from;
    while i <= last {
        match h[i..=last].iter().position(|&b| b == n[0]) {
            None => return None,
            Some(k) => {
                i += k;
                if &h[i..i + n.len()] == n {
                    return Some(i);
                }
                i += 1;
            }
        }
    }
    None
}

fn read_head(s: &mut TcpStream) -> Option<(Vec<u8>, Vec<u8>)> {
    let mut buf = Vec::with_capacity(4096);
    let mut tmp = [0u8; 8192];
    loop {
        if let Some(i) = find(&buf, b"\r\n\r\n", 0) {
            let rest = buf.split_off(i + 4);
            buf.truncate(i);
            return Some((buf, rest));
        }
        if buf.len() > 65536 {
            return None;
        }
        let n = s.read(&mut tmp).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
}

fn parse_head(head: &[u8]) -> (String, Vec<(String, String)>) {
    let text = String::from_utf8_lossy(head).to_string();
    let mut lines = text.split("\r\n");
    let first = lines.next().unwrap_or("").to_string();
    let headers = lines
        .filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_string(), v.trim().to_string())))
        .collect();
    (first, headers)
}

fn hget<'a>(h: &'a [(String, String)], name: &str) -> Option<&'a str> {
    h.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

// Decodes chunked data that has arrived so far. Returns true once the last chunk is seen.
fn dechunk_step(raw: &mut Vec<u8>, out: &mut Vec<u8>) -> bool {
    let mut p = 0usize;
    let mut done = false;
    loop {
        let Some(le) = find(raw, b"\r\n", p) else { break };
        let size_text = String::from_utf8_lossy(&raw[p..le]).to_string();
        let size_hex = size_text.split(';').next().unwrap_or("").trim().to_string();
        let Ok(size) = usize::from_str_radix(&size_hex, 16) else {
            done = true;
            p = raw.len();
            break;
        };
        if size == 0 {
            done = true;
            p = raw.len();
            break;
        }
        let start = le + 2;
        let end = start + size;
        if raw.len() < end + 2 {
            break;
        }
        out.extend_from_slice(&raw[start..end]);
        p = end + 2;
    }
    raw.drain(..p);
    done
}

fn replace_all(src: &[u8], needle: &[u8], with: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(src.len());
    let mut i = 0;
    while let Some(j) = find(src, needle, i) {
        out.extend_from_slice(&src[i..j]);
        out.extend_from_slice(with);
        i = j + needle.len();
    }
    out.extend_from_slice(&src[i..]);
    out
}

// env(safe-area-inset-top) -> var(--ml-inset-top), env(keyboard-inset-height) -> var(--ml-kb-height).
// Only the prefix is swapped, so fallbacks (`, 20px`), calc() and `"env(safe-area-inset-"+side` all keep working.
fn replace_safe_area(src: &[u8]) -> Vec<u8> {
    let a = replace_all(src, b"env(safe-area-inset-", b"var(--ml-inset-");
    replace_all(&a, b"env(keyboard-inset-", b"var(--ml-kb-")
}

fn inject_html(html: Vec<u8>) -> Vec<u8> {
    let lower: Vec<u8> = html.iter().map(|b| b.to_ascii_lowercase()).collect();
    let tag_end = |name: &[u8]| -> Option<usize> {
        let mut from = 0;
        while let Some(i) = find(&lower, name, from) {
            let next = lower.get(i + name.len()).copied().unwrap_or(b'>');
            if next == b'>' || next.is_ascii_whitespace() {
                return lower[i..].iter().position(|&b| b == b'>').map(|k| i + k + 1);
            }
            from = i + 1;
        }
        None
    };
    let pos = tag_end(b"<head").or_else(|| tag_end(b"<html")).unwrap_or(0);
    let block = inject_block();
    let mut out = Vec::with_capacity(html.len() + block.len());
    out.extend_from_slice(&html[..pos]);
    out.extend_from_slice(block.as_bytes());
    out.extend_from_slice(&html[pos..]);
    out
}

// kind: 1 = html, 2 = css/js
fn rewrite(kind: u8, body: Vec<u8>) -> Vec<u8> {
    let out = replace_safe_area(&body);
    if kind == 1 {
        inject_html(out)
    } else {
        out
    }
}

fn pipe(a: TcpStream, b: TcpStream) {
    let (Ok(mut a2), Ok(mut b2)) = (a.try_clone(), b.try_clone()) else { return };
    let t = thread::spawn(move || {
        let (mut a, mut b) = (a, b);
        let _ = io::copy(&mut a, &mut b);
        let _ = b.shutdown(Shutdown::Both);
        let _ = a.shutdown(Shutdown::Both);
    });
    let _ = io::copy(&mut b2, &mut a2);
    let _ = a2.shutdown(Shutdown::Both);
    let _ = b2.shutdown(Shutdown::Both);
    let _ = t.join();
}

fn handle_conn(mut client: TcpStream, upstream: u16) {
    let _ = client.set_nodelay(true);
    let Some((head, rest)) = read_head(&mut client) else { return };
    let (req_line, headers) = parse_head(&head);
    let Some(mut up) = connect_any(upstream) else {
        let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    };
    let _ = up.set_nodelay(true);
    let _ = up.set_read_timeout(None);

    // WebSocket (Fast Refresh / HMR): hand the raw connection straight through.
    let is_ws = hget(&headers, "upgrade").map(|v| v.eq_ignore_ascii_case("websocket")).unwrap_or(false);
    if is_ws {
        let mut raw = head.clone();
        raw.extend_from_slice(b"\r\n\r\n");
        raw.extend_from_slice(&rest);
        if up.write_all(&raw).is_ok() {
            pipe(client, up);
        }
        return;
    }

    let method = req_line.split(' ').next().unwrap_or("").to_string();
    let mut out = format!("{req_line}\r\n");
    for (k, v) in &headers {
        let l = k.to_ascii_lowercase();
        if matches!(l.as_str(), "accept-encoding" | "connection" | "proxy-connection" | "keep-alive") {
            continue;
        }
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out.push_str("Accept-Encoding: identity\r\nConnection: close\r\n\r\n");
    if up.write_all(out.as_bytes()).is_err() {
        return;
    }
    let clen: usize = hget(&headers, "content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    if clen > 0 {
        let have = rest.len().min(clen);
        if up.write_all(&rest[..have]).is_err() {
            return;
        }
        let _ = io::copy(&mut (&mut client).take((clen - have) as u64), &mut up);
    }

    let Some((rhead, rrest)) = read_head(&mut up) else {
        let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    };
    let (status_line, rh) = parse_head(&rhead);
    let status: u16 = status_line.split(' ').nth(1).and_then(|v| v.parse().ok()).unwrap_or(200);
    let ctype = hget(&rh, "content-type").unwrap_or("").to_ascii_lowercase();
    let kind: u8 = if ctype.contains("text/html") {
        1
    } else if ctype.contains("javascript") || ctype.contains("text/css") {
        2
    } else {
        0
    };
    let bodyless = method == "HEAD" || status < 200 || status == 204 || status == 304;
    let encoded = hget(&rh, "content-encoding").is_some();

    if kind == 0 || bodyless || encoded {
        // stream it as-is
        let mut raw = rhead.clone();
        raw.extend_from_slice(b"\r\n\r\n");
        raw.extend_from_slice(&rrest);
        if client.write_all(&raw).is_ok() {
            let _ = io::copy(&mut up, &mut client);
        }
        let _ = client.shutdown(Shutdown::Both);
        return;
    }

    // HTML / CSS / JS: buffer, rewrite, send with the right length
    let chunked = hget(&rh, "transfer-encoding").map(|v| v.to_ascii_lowercase().contains("chunked")).unwrap_or(false);
    let rlen: Option<usize> = hget(&rh, "content-length").and_then(|v| v.parse().ok());
    let mut body = Vec::new();
    let mut tmp = vec![0u8; 65536];
    if chunked {
        let mut raw = rrest;
        let mut done = dechunk_step(&mut raw, &mut body);
        while !done {
            let n = up.read(&mut tmp).unwrap_or(0);
            if n == 0 {
                break;
            }
            raw.extend_from_slice(&tmp[..n]);
            done = dechunk_step(&mut raw, &mut body);
        }
    } else {
        body = rrest;
        loop {
            if let Some(c) = rlen {
                if body.len() >= c {
                    break;
                }
            }
            let n = up.read(&mut tmp).unwrap_or(0);
            if n == 0 {
                break;
            }
            body.extend_from_slice(&tmp[..n]);
        }
        if let Some(c) = rlen {
            body.truncate(c);
        }
    }

    let body = rewrite(kind, body);
    let mut resp = format!("{status_line}\r\n");
    for (k, v) in &rh {
        let l = k.to_ascii_lowercase();
        if matches!(l.as_str(), "content-length" | "transfer-encoding" | "connection" | "keep-alive") {
            continue;
        }
        if l == "content-type" && kind == 1 && !v.to_ascii_lowercase().contains("charset") {
            resp.push_str(&format!("{k}: {v}; charset=utf-8\r\n"));
        } else {
            resp.push_str(&format!("{k}: {v}\r\n"));
        }
    }
    resp.push_str(&format!("Content-Length: {}\r\nConnection: close\r\n\r\n", body.len()));
    if client.write_all(resp.as_bytes()).is_ok() {
        let _ = client.write_all(&body);
    }
    let _ = client.shutdown(Shutdown::Both);
}

/* ───────────── server lifecycle ───────────── */

fn pump<R: Read + Send + 'static>(r: R, st: AppState) {
    thread::spawn(move || {
        let mut rd = BufReader::new(r);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match rd.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = strip_ansi(String::from_utf8_lossy(&buf).trim_end());
                    if line.trim().is_empty() {
                        continue;
                    }
                    let mut g = st.0.lock().unwrap();
                    g.log.push_back(line);
                    while g.log.len() > 60 {
                        g.log.pop_front();
                    }
                }
            }
        }
    });
}

// Watches one server: readiness, crashes, lost connection, automatic recovery.
// Polls quickly while starting and gently once running (light on old CPUs).
// `public` is the port the preview uses, `upstream` the port Metro itself listens on.
fn monitor(app: AppHandle, st: AppState, id: u64, public: u16, upstream: u16, external: bool) {
    thread::spawn(move || {
        let started = Instant::now();
        let mut running = external;
        let mut lost = false;
        let mut misses = 0u32;
        loop {
            thread::sleep(Duration::from_millis(if running && !lost { 1500 } else { 600 }));

            let (exited, tail) = {
                let mut g = st.0.lock().unwrap();
                let tail: Vec<String> = g.log.iter().cloned().collect();
                match g.server.as_mut() {
                    Some(sv) if sv.id == id => {
                        let exited = match sv.child.as_mut() {
                            Some(c) => matches!(c.try_wait(), Ok(Some(_))),
                            None => false,
                        };
                        (exited, tail)
                    }
                    _ => return, // stopped or replaced
                }
            };

            if exited {
                {
                    let mut g = st.0.lock().unwrap();
                    if g.server.as_ref().map(|s| s.id) == Some(id) {
                        g.server = None; // also stops the proxy
                    }
                }
                let (m, h) = explain(&tail);
                emit(&app, payload("error", None, Some(m), Some(h), false));
                return;
            }

            if connect_any(upstream).is_some() {
                misses = 0;
                if !running || lost {
                    running = true;
                    lost = false;
                    emit(&app, payload("running", Some(public), None, None, external));
                }
            } else if running {
                misses += 1;
                if misses >= 2 && !lost {
                    lost = true;
                    emit(
                        &app,
                        payload(
                            "lost",
                            Some(public),
                            Some("Connection to the Expo server was lost.".into()),
                            None,
                            external,
                        ),
                    );
                }
            } else if started.elapsed() > Duration::from_secs(START_TIMEOUT_SECS) {
                let sv = {
                    let mut g = st.0.lock().unwrap();
                    if g.server.as_ref().map(|s| s.id) == Some(id) {
                        g.server.take()
                    } else {
                        None
                    }
                };
                if let Some(mut s) = sv {
                    if let Some(c) = s.child.as_mut() {
                        kill_tree(c);
                    }
                }
                emit(
                    &app,
                    payload(
                        "error",
                        None,
                        Some("Expo did not start in time.".into()),
                        Some("Check the project in VS Code (try `npx expo start` in a terminal), then press Start again.".into()),
                        false,
                    ),
                );
                return;
            }
        }
    });
}

fn attach_inner(app: &AppHandle, st: &AppState, path: &str) -> Option<u16> {
    if st.0.lock().unwrap().server.is_some() {
        return None;
    }
    for upstream in FIRST_PORT..=LAST_PORT {
        if let Some(root) = probe_metro(upstream) {
            if !root.is_empty() && norm(&root) == norm(path) {
                let proxy = start_proxy(None, upstream);
                let public = proxy.as_ref().map(|p| p.port).unwrap_or(upstream);
                let id = {
                    let mut g = st.0.lock().unwrap();
                    g.next_id += 1;
                    let id = g.next_id;
                    g.server = Some(Server {
                        child: None,
                        port: public,
                        upstream,
                        path: path.to_string(),
                        id,
                        proxy,
                    });
                    id
                };
                emit(app, payload("running", Some(public), None, None, true));
                monitor(app.clone(), st.clone(), id, public, upstream, true);
                return Some(public);
            }
        }
    }
    None
}

fn start_inner(app: &AppHandle, st: &AppState, path: &str) -> Result<u16, Problem> {
    let dir = PathBuf::from(path);
    let info = inspect(&dir)?;

    {
        let g = st.0.lock().unwrap();
        if let Some(sv) = &g.server {
            return if norm(&sv.path) == norm(path) {
                Ok(sv.port) // already running: never launch a duplicate
            } else {
                Err(problem(
                    "Another project's Expo server is running.",
                    "Stop it first, then start this project.",
                ))
            };
        }
    }

    if !info.installed {
        return Err(problem(
            "Project dependencies are not installed.",
            &format!("Run `{} install` in the project folder, then press Start.", info.manager),
        ));
    }
    if !info.web_missing.is_empty() {
        return Err(problem(
            "Expo Web support is missing.",
            &format!("Run `npx expo install {}` in the project folder, then press Start.", info.web_missing.join(" ")),
        ));
    }
    if node_version().is_none() {
        return Err(problem(
            "Node.js was not found.",
            "Install Node.js (LTS) from nodejs.org, then restart MobileLab.",
        ));
    }
    let tool = if info.manager == "npm" { "npx" } else { info.manager.as_str() };
    let tool_ok = shell(&[tool, "--version"]).output().map(|o| o.status.success()).unwrap_or(false);
    if !tool_ok {
        return Err(problem(
            &format!("`{tool}` was not found."),
            "Install your package manager (for example `npm install -g pnpm`), then restart MobileLab.",
        ));
    }

    // The page is served on `public` (8081, 8082…) so the app sees a familiar localhost origin;
    // Metro runs behind it on its own port. If the proxy cannot start, Metro uses `public` directly.
    let public = find_free_port().ok_or_else(|| {
        problem(
            "No free port between 8081 and 8099.",
            "Close other development servers and try again.",
        )
    })?;
    let proxy = match find_free_port_in(UPSTREAM_FIRST, UPSTREAM_LAST) {
        Some(up) => start_proxy(Some(public), up).map(|p| (p, up)),
        None => None,
    };
    let (metro_port, proxy) = match proxy {
        Some((p, up)) => (up, Some(p)),
        None => (public, None),
    };
    let port_s = metro_port.to_string();

    let mut args: Vec<&str> = match info.manager.as_str() {
        "pnpm" => vec!["pnpm", "exec", "expo", "start"],
        "yarn" => vec!["yarn", "expo", "start"],
        _ => vec!["npx", "--no-install", "expo", "start"],
    };
    args.extend(["--host", "localhost", "--port", port_s.as_str()]);

    let mut cmd = shell(&args);
    cmd.current_dir(&dir)
        .env("EXPO_NO_TELEMETRY", "1")
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    cmd.process_group(0);

    st.0.lock().unwrap().log.clear();
    let mut child = cmd
        .spawn()
        .map_err(|e| problem("Could not launch Expo.", &e.to_string()))?;
    if let Some(o) = child.stdout.take() {
        pump(o, st.clone());
    }
    if let Some(e) = child.stderr.take() {
        pump(e, st.clone());
    }

    let id = {
        let mut g = st.0.lock().unwrap();
        if let Some(sv) = &g.server {
            let p = sv.port;
            drop(g);
            kill_tree(&mut child);
            return Ok(p);
        }
        g.next_id += 1;
        let id = g.next_id;
        g.server = Some(Server {
            child: Some(child),
            port: public,
            upstream: metro_port,
            path: path.to_string(),
            id,
            proxy,
        });
        id
    };

    emit(app, payload("starting", Some(public), None, None, false));
    monitor(app.clone(), st.clone(), id, public, metro_port, false);
    Ok(public)
}

/* ───────────── commands ───────────── */

#[tauri::command]
async fn detect_project(path: String) -> Result<ProjectInfo, Problem> {
    inspect(Path::new(&path))
}

// Re-use a server the developer already started for this project.
#[tauri::command]
async fn attach_existing(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<Option<u16>, Problem> {
    Ok(attach_inner(&app, state.inner(), &path))
}

#[tauri::command]
async fn start_server(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<u16, Problem> {
    let st = state.inner().clone();
    if let Some(p) = attach_inner(&app, &st, &path) {
        return Ok(p);
    }
    start_inner(&app, &st, &path)
}

#[tauri::command]
async fn stop_server(app: AppHandle, state: State<'_, AppState>) -> Result<(), Problem> {
    stop_inner(state.inner());
    emit(&app, payload("stopped", None, None, None, false));
    Ok(())
}

#[tauri::command]
async fn reconnect_server(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<u16, Problem> {
    let st = state.inner().clone();
    let current = st
        .0
        .lock()
        .unwrap()
        .server
        .as_ref()
        .map(|s| (s.port, s.upstream, s.child.is_none()));
    if let Some((public, upstream, external)) = current {
        if connect_any(upstream).is_some() {
            emit(&app, payload("running", Some(public), None, None, external));
            return Ok(public);
        }
    }
    stop_inner(&st);
    if let Some(p) = attach_inner(&app, &st, &path) {
        return Ok(p);
    }
    start_inner(&app, &st, &path)
}

// Lets the UI resync after a webview reload (and lets the floating window read the state).
#[tauri::command]
fn server_status(state: State<'_, AppState>) -> ServerPayload {
    let g = state.0.lock().unwrap();
    match &g.server {
        Some(sv) => {
            let external = sv.child.is_none();
            let state_name = if connect_any(sv.upstream).is_some() {
                "running"
            } else if external {
                "lost"
            } else {
                "starting"
            };
            payload(state_name, Some(sv.port), None, None, external)
        }
        None => payload("stopped", None, None, None, false),
    }
}

/* ───────────── floating simulator window ─────────────
   A second, frameless, transparent window that shows only the phone. Metro keeps running
   (nothing is restarted); the main window hides itself and drops its own preview so only
   one copy of the app is alive. */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FloatArgs {
    device_id: String,
    landscape: bool,
    scale: f64,
    width: f64,
    height: f64,
    x: Option<f64>,
    y: Option<f64>,
    on_top: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FloatCfg {
    device_id: String,
    landscape: bool,
    scale: f64,
}

struct FloatExit {
    landscape: bool,
    close_session: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FloatEvent {
    open: bool,
    device_id: Option<String>,
    landscape: Option<bool>,
    close_session: bool,
}

fn show_main(app: &AppHandle) {
    if let Some(m) = app.get_webview_window("main") {
        let _ = m.show();
        let _ = m.unminimize();
        let _ = m.set_focus();
    }
}

// Runs whenever the floating window is gone, however it was closed.
fn floating_closed(app: &AppHandle) {
    let (cfg, exit) = {
        let st = app.state::<AppState>();
        let mut g = st.0.lock().unwrap();
        (g.float_cfg.take(), g.float_exit.take())
    };
    show_main(app);
    let ev = FloatEvent {
        open: false,
        device_id: cfg.map(|c| c.device_id),
        landscape: exit.as_ref().map(|e| e.landscape),
        close_session: exit.map(|e| e.close_session).unwrap_or(false),
    };
    let _ = app.emit("floating-state", ev);
}

#[tauri::command]
async fn open_floating(app: AppHandle, state: State<'_, AppState>, args: FloatArgs) -> Result<(), Problem> {
    {
        let mut g = state.0.lock().unwrap();
        g.float_cfg = Some(FloatCfg { device_id: args.device_id.clone(), landscape: args.landscape, scale: args.scale });
        g.float_exit = None;
    }
    if let Some(w) = app.get_webview_window("floating") {
        let _ = w.show(); // never a second floating window
        let _ = w.set_focus();
    } else {
        let mut b = WebviewWindowBuilder::new(&app, "floating", WebviewUrl::App("index.html".into()))
            .title("MobileLab Simulator")
            .inner_size(args.width, args.height)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .maximizable(false)
            .always_on_top(args.on_top)
            .focused(true);
        b = match (args.x, args.y) {
            (Some(x), Some(y)) => b.position(x, y),
            _ => b.center(),
        };
        b.build()
            .map_err(|e| problem("Could not open the floating window.", &e.to_string()))?;
    }
    if let Some(m) = app.get_webview_window("main") {
        let _ = m.hide();
    }
    Ok(())
}

#[tauri::command]
fn floating_config(state: State<'_, AppState>) -> Option<FloatCfg> {
    state.0.lock().unwrap().float_cfg.clone()
}

#[tauri::command]
async fn exit_floating(
    app: AppHandle,
    state: State<'_, AppState>,
    landscape: bool,
    close_session: bool,
) -> Result<(), Problem> {
    state.0.lock().unwrap().float_exit = Some(FloatExit { landscape, close_session });
    match app.get_webview_window("floating") {
        Some(w) => {
            let _ = w.destroy(); // the window-event handler brings the dashboard back
        }
        None => floating_closed(&app),
    }
    Ok(())
}

// Last lines printed by Expo, so the UI can offer "Copy log" on errors.
#[tauri::command]
fn get_log(state: State<'_, AppState>) -> Vec<String> {
    state.0.lock().unwrap().log.iter().cloned().collect()
}

// Total RAM in MB, used to decide how many simulators may run at once.
#[tauri::command]
async fn system_memory_mb() -> Option<u64> {
    #[cfg(windows)]
    {
        let out = base("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory",
            ])
            .output()
            .ok()?;
        let bytes: u64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
        return Some(bytes / 1024 / 1024);
    }
    #[cfg(target_os = "linux")]
    {
        let t = fs::read_to_string("/proc/meminfo").ok()?;
        let kb: u64 = t
            .lines()
            .find(|l| l.starts_with("MemTotal:"))?
            .split_whitespace()
            .nth(1)?
            .parse()
            .ok()?;
        return Some(kb / 1024);
    }
    #[allow(unreachable_code)]
    None
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .on_window_event(|window, event| {
            if window.label() == "floating" {
                if let tauri::WindowEvent::Destroyed = event {
                    floating_closed(window.app_handle());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            detect_project,
            attach_existing,
            start_server,
            stop_server,
            reconnect_server,
            server_status,
            get_log,
            system_memory_mb,
            open_floating,
            floating_config,
            exit_floating
        ])
        .build(tauri::generate_context!())
        .expect("error while building MobileLab")
        .run(|app, event| {
            // Never leave an Expo process behind when MobileLab closes.
            if let RunEvent::Exit = event {
                stop_inner(app.state::<AppState>().inner());
            }
        });
}

/* ───────────── tests (cargo test) ───────────── */

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mobilelab-test-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn norm_handles_windows_paths() {
        assert_eq!(norm(r"C:\Users\Me\App\"), "c:/users/me/app");
        assert_eq!(norm(r"\\?\C:\Users\Me\App"), "c:/users/me/app");
        assert_eq!(norm("/home/me/app/"), "/home/me/app");
    }

    #[test]
    fn strips_ansi_colors() {
        assert_eq!(strip_ansi("\u{1b}[31merror\u{1b}[0m: boom"), "error: boom");
    }

    #[test]
    fn explains_common_failures() {
        let l = |s: &str| vec![s.to_string()];
        assert!(explain(&l("Error: listen EADDRINUSE: address already in use :::8081")).0.contains("port"));
        assert!(explain(&l("Error: Cannot find module 'expo'")).0.contains("dependency"));
        assert!(explain(&l("Unable to resolve react-native-web")).0.contains("Web"));
        assert!(explain(&l("'npx' is not recognized as a command")).0.contains("tool"));
        assert!(explain(&[]).0.contains("unexpectedly"));
    }

    #[test]
    fn rejects_bad_folders() {
        assert!(inspect(Path::new("/definitely/not/here")).is_err());
        let d = temp_project("nopkg");
        assert!(inspect(&d).is_err());
        fs::write(d.join("package.json"), "{ not json").unwrap();
        assert!(inspect(&d).is_err());
        fs::write(d.join("package.json"), r#"{"name":"x","dependencies":{"react":"1"}}"#).unwrap();
        assert!(inspect(&d).unwrap_err().message.contains("not an Expo project"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn detects_expo_project_and_manager() {
        let d = temp_project("expo");
        fs::write(d.join("package.json"), r#"{"name":"demo","dependencies":{"expo":"~52.0.0"}}"#).unwrap();
        let info = inspect(&d).unwrap();
        assert_eq!(info.name, "demo");
        assert_eq!(info.manager, "npm");
        assert!(!info.installed);
        assert!(info.warnings.iter().any(|w| w.contains("install")));

        fs::write(d.join("pnpm-lock.yaml"), "").unwrap();
        assert_eq!(inspect(&d).unwrap().manager, "pnpm");
        fs::remove_file(d.join("pnpm-lock.yaml")).unwrap();
        fs::write(d.join("yarn.lock"), "").unwrap();
        assert_eq!(inspect(&d).unwrap().manager, "yarn");

        // installed, but no web packages yet
        fs::create_dir_all(d.join("node_modules").join("expo")).unwrap();
        let info = inspect(&d).unwrap();
        assert!(info.installed);
        assert_eq!(info.web_missing.len(), 3);
        fs::create_dir_all(d.join("node_modules").join("react-dom")).unwrap();
        fs::create_dir_all(d.join("node_modules").join("react-native-web")).unwrap();
        fs::create_dir_all(d.join("node_modules").join("@expo").join("metro-runtime")).unwrap();
        assert!(inspect(&d).unwrap().web_missing.is_empty());
        let _ = fs::remove_dir_all(&d);
    }

    fn fake_server(response: &'static str) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let mut buf = [0u8; 512];
                let _ = s.read(&mut buf);
                let _ = s.write_all(response.as_bytes());
            }
        });
        port
    }

    #[test]
    fn probes_metro_status_and_project_root() {
        let port = fake_server(
            "HTTP/1.1 200 OK\r\nX-React-Native-Project-Root: C:\\proj\\demo\r\nConnection: close\r\n\r\npackager-status:running",
        );
        assert_eq!(probe_metro(port).as_deref(), Some("C:\\proj\\demo"));
    }

    #[test]
    fn ignores_servers_that_are_not_metro() {
        let port = fake_server("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nhello");
        assert!(probe_metro(port).is_none());
    }


    #[test]
    fn rewrites_safe_area_env_to_variables() {
        let src = b"a{padding:env(safe-area-inset-top)} b{margin:calc(env(safe-area-inset-bottom, 4px) + 1px)} c{x:env(safe-area-inset-left)env(safe-area-inset-right)} k{h:env(keyboard-inset-height)} s=\"env(safe-area-inset-\"+side+\")\"";
        let out = String::from_utf8(replace_safe_area(src)).unwrap();
        assert_eq!(
            out,
            "a{padding:var(--ml-inset-top)} b{margin:calc(var(--ml-inset-bottom, 4px) + 1px)} c{x:var(--ml-inset-left)var(--ml-inset-right)} k{h:var(--ml-kb-height)} s=\"var(--ml-inset-\"+side+\")\""
        );
        assert_eq!(replace_safe_area(b"no match here"), b"no match here".to_vec());
    }

    #[test]
    fn injects_after_head_without_breaking_the_doctype() {
        let html = b"<!DOCTYPE html><html><HEAD lang=x><meta charset=utf-8></HEAD><body><header>h</header></body></html>".to_vec();
        let out = String::from_utf8(inject_html(html)).unwrap();
        assert!(out.starts_with("<!DOCTYPE html><html><HEAD lang=x><style id=\"ml-safe\">"));
        assert!(out.contains("</script><meta charset=utf-8>"));
        assert!(!INJECT_JS.contains("</script"), "the helper must never close its own script tag");
        // no <head>: falls back to after <html>, never before the doctype
        let out = String::from_utf8(inject_html(b"<!doctype html><html><body></body></html>".to_vec())).unwrap();
        assert!(out.starts_with("<!doctype html><html><style"));
    }

    #[test]
    fn decodes_chunked_bodies_incrementally() {
        let mut raw = b"5\r\nhel".to_vec();
        let mut out = Vec::new();
        assert!(!dechunk_step(&mut raw, &mut out));
        raw.extend_from_slice(b"lo\r\n6;ext=1\r\n world\r\n0\r\n\r\n");
        assert!(dechunk_step(&mut raw, &mut out));
        assert_eq!(out, b"hello world".to_vec());
    }

    #[test]
    fn port_checks_see_busy_ports() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        assert!(!port_is_free(port));
        assert!(connect_any(port).is_some());
        drop(l);
    }
}