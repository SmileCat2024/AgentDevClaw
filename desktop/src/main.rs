// Claw 桌面壳（Tauri）。
//
// 桌面进程启动并观察服务（见 docs/protocols/service-lifecycle.md）：
//   启动：先检查本机是否已有 ready 服务；有则只恢复前台，无则 spawn supervisor
//   单实例：重复运行 exe 只激活已有实例（聚焦主窗口），第二实例随即退出；
//           第二实例携带右键唤起参数（--claw-open/--claw-new-chat）时同时
//           把请求转发给已运行实例的 webview（见 deliver_open_request）
//   右键唤起：installer-hooks.nsh 注册 HKCU Directory\Background 菜单
//           「在编程小助手中打开 / 创建会话」。冷启动把参数拼进窗口 URL
//           query，已运行则经 single-instance argv 转发；前端统一在
//           public/src/modules/desktop-open.js 消费
//   权限：WebView 权限对 Claw 服务源自动放行（通知等），不弹用户询问
//   就绪：等 Claw health 确认 ready 后建窗口，避免误连任意端口占用者
//   关窗：隐藏界面，服务和宿主继续运行，可从系统托盘恢复
//   退出：用户在设置或托盘选择退出 → server 自主有序关闭；
//         宿主随服务退出，显式退出等待超时后只清理自己创建的服务子树
//
// 当前为开发切片形态：仓库根取编译期 CARGO_MANIFEST_DIR（CLAW_DESKTOP_ROOT
// 可指向 pack:desktop 产出的发布树）；Node 优先用发布树 runtime/ 内的随包
// 副本，缺失时回退 PATH。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::PermissionResponse;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// 托管目标树：CLAW_DESKTOP_ROOT 显式指定（pack:desktop 产出的发布树）；
/// 打包布局取 exe 同级 app/（bundle.resources 映射，以 server.js 存在性
/// 识别）；缺省（开发态）取编译期仓库根。
fn repo_root() -> PathBuf {
    if let Ok(p) = std::env::var("CLAW_DESKTOP_ROOT") {
        return PathBuf::from(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join("app");
            if bundled.join("server.js").is_file() {
                return bundled;
            }
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("desktop/ 的上级即仓库根")
        .to_path_buf()
}

/// Node 解释器：发布树 runtime/ 随包副本优先，开发态回退 PATH。
fn node_command() -> Command {
    let bundled = repo_root()
        .join("runtime")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    if bundled.exists() {
        return Command::new(bundled);
    }
    Command::new("node")
}

fn service_port() -> u16 {
    std::env::var("PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1420)
}

/// 读取与 run-supervised.js 相同的环境变量保证优雅窗口同步，+2s 留给 supervisor 自身收尾。
fn supervisor_grace() -> Duration {
    let ms = std::env::var("CLAW_SUPERVISOR_GRACE_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(10_000);
    Duration::from_millis(ms + 2_000)
}

fn json_field<'a>(body: &'a str, key: &str) -> Option<&'a str> {
    body.split_once(&format!("\"{key}\""))?
        .1
        .trim_start()
        .strip_prefix(':')
        .map(str::trim_start)
}

fn json_string_field<'a>(body: &'a str, key: &str) -> Option<&'a str> {
    let value = json_field(body, key)?.strip_prefix('"')?;
    Some(&value[..value.find('"')?])
}

fn json_u32_field(body: &str, key: &str) -> Option<u32> {
    let value = json_field(body, key)?;
    let digits: String = value.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// 只把返回 Claw ready 健康响应的本地服务视为可连接目标，并记住 PID，
/// 避免后续退出请求误发给已经接管该端口的其他进程。
fn service_ready_pid(port: u16) -> Option<u32> {
    let address = format!("127.0.0.1:{port}");
    let Ok(mut stream) = TcpStream::connect_timeout(
        &address.parse().expect("loopback addr"),
        Duration::from_millis(500),
    ) else {
        return None;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(700)));
    let request = format!(
        "GET /protoclaw/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return None;
    }

    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    let Some((headers, body)) = response.split_once("\r\n\r\n") else {
        return None;
    };
    let status_ok = headers
        .lines()
        .next()
        .is_some_and(|line| line.starts_with("HTTP/1.") && line.contains(" 200 "));
    if !status_ok
        || !json_field(body, "ok").is_some_and(|value| value.starts_with("true"))
        || json_string_field(body, "state") != Some("ready")
        || json_u32_field(body, "appPort") != Some(u32::from(port))
    {
        return None;
    }
    json_u32_field(body, "pid").filter(|pid| *pid > 0)
}

fn service_is_ready(port: u16) -> bool {
    service_ready_pid(port).is_some()
}

fn spawn_supervisor() -> std::io::Result<Child> {
    let repo_root = repo_root();
    let node_path = repo_root
        .join("runtime")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    let mut cmd = node_command();
    cmd.args(["scripts/run-supervised.js"])
        .current_dir(&repo_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if node_path.is_file() {
        cmd.env("AGENTDEV_STUDIO_NODE_PATH", &node_path)
            .env("AGENTDEV_STUDIO_NPM_PATH", repo_root.join("runtime").join("npm").join("bin").join("npm-cli.js"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn()?;
    // 管道必须持续排空，否则缓冲写满会阻塞 supervisor
    if let Some(stdout) = child.stdout.take() {
        drain_logs(stdout);
    }
    if let Some(stderr) = child.stderr.take() {
        drain_logs(stderr);
    }
    Ok(child)
}

fn drain_logs<R: Read + Send + 'static>(stream: R) {
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            eprintln!("[claw] {line}");
        }
    });
}

fn wait_service_ready(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if service_is_ready(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

fn service_listener_is_open(port: u16) -> bool {
    let address = format!("127.0.0.1:{port}");
    TcpStream::connect_timeout(
        &address.parse().expect("loopback addr"),
        Duration::from_millis(250),
    )
    .is_ok()
}

struct DesktopService {
    supervisor: Option<Child>,
    supervisor_exited: bool,
    attached_to_running_service: bool,
    service_ready_seen: bool,
    service_pid: Option<u32>,
    window_created: bool,
    unavailable_since: Option<Instant>,
}

fn wait_service_stopped(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !service_listener_is_open(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

/// 请求 server 自主有序关闭（SSE 通知、runtime 停机、端口释放在 server 侧完成）。
/// 仅在用户明确退出且已确认 Claw 服务就绪时调用；请求失败不阻塞。
fn request_server_shutdown(port: u16, expected_pid: u32) {
    if service_ready_pid(port) != Some(expected_pid) {
        eprintln!("[claw-desktop] Claw service identity changed; skipping shutdown request");
        return;
    }
    let Ok(mut stream) = TcpStream::connect(format!("127.0.0.1:{port}")) else {
        return;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = format!(
        "POST /protoclaw/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\n\
         Content-Length: 0\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_ok() {
        let mut sink = [0u8; 64];
        let _ = stream.read(&mut sink); // 收到响应首包即返回
    }
}

fn show_main_window(handle: &tauri::AppHandle) {
    if let Some(window) = handle.get_webview_window("main") {
        // Windows 前台锁定策略会拒绝后台进程的 set_focus（只闪任务栏图标），
        // 最小化窗口 show() 也不会还原。托盘隐藏 / 最小化 / 可见但失焦三种
        // 状态都要能带到前台：先 unminimize + show，再用置顶翻转
        // （topmost → focus → 取消 topmost）绕过前台锁定。
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_always_on_top(true);
        let _ = window.set_focus();
        let _ = window.set_always_on_top(false);
    }
}

/// 右键菜单唤起请求（installer-hooks.nsh 注册的注册表命令携带，%V 展开为
/// 右键时所在目录）。action 与前端 modules/desktop-open.js 的约定保持一致。
#[derive(Clone, Debug)]
struct OpenRequest {
    /// "open"（切工作空间并定位目录）| "new-chat"（切工作空间并新建对话）
    action: &'static str,
    dir: String,
}

impl OpenRequest {
    /// 冷启动传递路径的窗口 URL query 键。
    fn query_key(&self) -> &'static str {
        match self.action {
            "new-chat" => "claw-new-chat",
            _ => "claw-open",
        }
    }
}

/// 解析命令行参数中的右键唤起请求：--claw-open=<dir> / --claw-new-chat=<dir>。
/// 多次出现以最后一次为准；空目录值忽略（视为无请求）。
fn parse_open_request<I, S>(args: I) -> Option<OpenRequest>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut request = None;
    for arg in args {
        let arg = arg.as_ref();
        if let Some(dir) = arg.strip_prefix("--claw-new-chat=") {
            if !dir.is_empty() {
                request = Some(OpenRequest { action: "new-chat", dir: dir.to_string() });
            }
        } else if let Some(dir) = arg.strip_prefix("--claw-open=") {
            if !dir.is_empty() {
                request = Some(OpenRequest { action: "open", dir: dir.to_string() });
            }
        }
    }
    request
}

/// 最小 percent-encoding：非 unreserved（A-Za-z0-9-_.~）字节全部 %XX。
/// 仅用于把目录路径嵌入窗口 URL query，前端 URLSearchParams 自动解码。
fn percent_encode(input: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(input.len());
    for &byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => {
                out.push('%');
                out.push(HEX[(byte >> 4) as usize] as char);
                out.push(HEX[(byte & 0x0F) as usize] as char);
            }
        }
    }
    out
}

/// 转义为 JS 字符串字面量内容（不含外层引号），webview eval 传参用。
/// 覆盖 Windows 路径的 `\`、`"` 与控制字符，其余字符按原样（UTF-8）。
fn js_string_literal(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// 已运行实例收到第二实例的右键唤起参数：经 webview eval 交给前端
/// modules/desktop-open.js 的统一消费入口。窗口尚未创建（服务启动中）时
/// 忽略本次请求——与既有激活语义一致；冷启动场景本就不依赖该转发
/// （参数由首实例自己的 argv 走窗口 URL query）。
fn deliver_open_request(handle: &tauri::AppHandle, request: &OpenRequest) {
    let Some(window) = handle.get_webview_window("main") else {
        return;
    };
    let script = format!(
        "window.__clawConsumeOpenRequest && window.__clawConsumeOpenRequest({{ action: '{}', cwd: \"{}\" }})",
        request.action,
        js_string_literal(&request.dir)
    );
    if let Err(err) = window.eval(&script) {
        eprintln!("[claw-desktop] failed to deliver open request: {err}");
    }
}

/// WebView 权限只对本壳托管的 Claw 服务源自动放行；窗口内一旦导航到
/// 外部站点，回落 WebView2 默认行为，不替外部源背书权限。
fn is_service_origin(url: &tauri::Url) -> bool {
    url.host_str() == Some("127.0.0.1") && url.port() == Some(service_port())
}

/// 持久通知走 Windows 原生 toast（Scenario::Reminder：常驻屏幕直到用户
/// 处理）。WebView2 的 Web Notification 不兑现 requireInteraction（toast
/// 默认 5 秒收进通知中心），壳内持久类通知经此 command 转系统通知。
/// AUMID 与通知插件一致（app identifier），toast 归属与点击激活指向本应用。
///
/// 点击行为（点本体 / 点「查看」按钮统一）：拉窗口到前台 + 经 webview eval
/// 把 nav_payload（前端组装的会话定位 JSON，壳不解释语义）交回前端导航
/// 入口（modules/desktop-notify.js 的 __clawConsumeNotificationActivation，
/// 与右键唤起 __clawConsumeOpenRequest 同模式）；点 X 关闭是纯 dismiss，
/// 不唤起不导航。nav_payload 为空时只拉前台不导航。
#[tauri::command]
fn persistent_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
    nav_payload: Option<String>,
) -> Result<(), String> {
    let handle = app.clone();
    let eval_payload = nav_payload.as_deref().map(js_string_literal).unwrap_or_default();
    let result = tauri_winrt_notification::Toast::new(&app.config().identifier)
        .title(&title)
        .text2(&body)
        // Windows 对 scenario=Reminder 的硬性要求：toast 必须至少带一个按钮，
        // 否则系统静默降级为普通 toast（约 5 秒收进通知中心，show 仍返回 Ok）。
        // 按钮语义与点本体一致（切回应用并定位会话），不是「知道了」。
        .add_button("查看", "view")
        .scenario(tauri_winrt_notification::Scenario::Reminder)
        .on_activated(move |action| {
            // COM 回调线程，AppHandle/WebviewWindow 跨线程可用
            println!("[claw-desktop] notification activated: {:?}", action);
            show_main_window(&handle);
            if !eval_payload.is_empty() {
                if let Some(window) = handle.get_webview_window("main") {
                    let script = format!(
                        "window.__clawConsumeNotificationActivation && \
                         window.__clawConsumeNotificationActivation(\"{}\")",
                        eval_payload
                    );
                    if let Err(err) = window.eval(&script) {
                        eprintln!("[claw-desktop] failed to deliver notification activation: {err}");
                    }
                }
            }
            Ok(())
        })
        .show();
    match &result {
        Ok(()) => println!("[claw-desktop] persistent notification shown"),
        Err(err) => eprintln!("[claw-desktop] persistent notification failed: {err}"),
    }
    result.map_err(|e| e.to_string())
}

fn main() {
    // 右键唤起参数（首实例冷启动路径）：随窗口 URL query 交给前端。
    let open_request = parse_open_request(std::env::args());
    let app = tauri::Builder::default()
        // 单实例：须最先注册。第二实例把激活转交给已运行实例后自行退出，
        // 不进入 setup（不重复探测服务 / spawn supervisor）。携带右键唤起
        // 参数时，激活同时把请求转发给已运行实例的 webview。
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(request) = parse_open_request(argv) {
                deliver_open_request(app, &request);
            }
            show_main_window(app);
        }))
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![persistent_notification])
        // 服务源内的全部 WebView 权限（通知 / 麦克风 / 剪贴板等）自动授予，
        // 不向用户弹询问；前端 Notification.requestPermission 因此直接得 granted。
        .on_permission_request(|webview, _kind| {
            let on_service_origin = webview
                .url()
                .map(|url| is_service_origin(&url))
                .unwrap_or(false);
            if on_service_origin {
                PermissionResponse::Allow
            } else {
                PermissionResponse::Default
            }
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let open = MenuItem::with_id(app, "open", "打开工作台", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出程序", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let icon = app.default_window_icon().expect("desktop icon").clone();
            TrayIconBuilder::new()
                .icon(icon)
                .tooltip("Agent 工作台")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|handle, event| match event.id().as_ref() {
                    "open" => show_main_window(handle),
                    "quit" => handle.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
            let port = service_port();
            let existing_service_pid = service_ready_pid(port);
            let already_running = existing_service_pid.is_some();
            let supervisor = if already_running {
                eprintln!("[claw-desktop] attaching to ready service on port {port}");
                None
            } else {
                match spawn_supervisor() {
                    Ok(child) => Some(child),
                    Err(err) => {
                        eprintln!("[claw-desktop] spawn supervisor failed: {err}");
                        None
                    }
                }
            };
            let service_state = Mutex::new(DesktopService {
                supervisor_exited: already_running || supervisor.is_none(),
                attached_to_running_service: already_running,
                service_ready_seen: already_running,
                service_pid: existing_service_pid,
                supervisor,
                window_created: false,
                unavailable_since: None,
            });
            app.manage(service_state);
            let watcher = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(500));
                let ready_pid = service_ready_pid(port);
                let ready = ready_pid.is_some();
                let listener_open = service_listener_is_open(port);
                let state = watcher.state::<Mutex<DesktopService>>();
                let should_exit = {
                    let mut guard = state.lock().unwrap();
                    if ready || listener_open {
                        guard.unavailable_since = None;
                    }
                    if ready {
                        guard.service_ready_seen = true;
                        if guard.service_pid.is_none() {
                            guard.service_pid = ready_pid;
                        }
                        if guard.supervisor_exited {
                            guard.attached_to_running_service = true;
                        }
                    }

                    let supervisor_finished = match guard.supervisor.as_mut() {
                        Some(child) => matches!(child.try_wait(), Ok(Some(_))),
                        None => false,
                    };
                    if supervisor_finished {
                        guard.supervisor = None;
                        guard.supervisor_exited = true;
                        if ready {
                            guard.attached_to_running_service = true;
                        }
                    }

                    if !ready && supervisor_finished && guard.service_ready_seen {
                        true // 服务曾就绪后退出，桌面宿主跟随退出
                    } else if guard.attached_to_running_service
                        && guard.window_created
                        && !listener_open
                    {
                        let since = guard.unavailable_since.get_or_insert_with(Instant::now);
                        since.elapsed() >= Duration::from_secs(3)
                    } else {
                        false
                    }
                };
                if should_exit {
                    watcher.exit(0);
                    break;
                }
            });

            // 窗口创建必须经事件循环（AppHandle 代理）投递；在 run() 启动前的
            // 主线程上直接 build 会因 WebView2 初始化等不到循环分发而挂死（实测）。
            let open_request = open_request.clone();
            std::thread::spawn(move || {
                let service_ready = wait_service_ready(port, Duration::from_secs(15));
                if !service_ready {
                    eprintln!("[claw-desktop] Claw service not ready on port {port} after 15s; opening the window so the startup problem remains visible");
                }
                // 冷启动右键唤起：参数拼进首屏 URL query，前端 boot 序列消费。
                let mut url_string = format!("http://127.0.0.1:{port}/");
                if let Some(request) = &open_request {
                    url_string.push('?');
                    url_string.push_str(request.query_key());
                    url_string.push('=');
                    url_string.push_str(&percent_encode(&request.dir));
                }
                let url: tauri::Url = url_string.parse().expect("service url");
                let result = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(url))
                    .title("Agent 工作台")
                    .inner_size(1600.0, 1000.0)
                    .min_inner_size(1100.0, 700.0)
                    .maximized(true)
                    .disable_drag_drop_handler()
                    .build();
                match result {
                    Ok(_) => {
                        let state = handle.state::<Mutex<DesktopService>>();
                        let mut guard = state.lock().unwrap();
                        guard.window_created = true;
                        if service_ready {
                            guard.service_ready_seen = true;
                            if guard.service_pid.is_none() {
                                guard.service_pid = service_ready_pid(port);
                            }
                            if guard.supervisor_exited {
                                guard.attached_to_running_service = true;
                            }
                        }
                    }
                    Err(err) => eprintln!("[claw-desktop] failed to create main window: {err}"),
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    let port = service_port();
    app.run(move |app_handle, event| {
        if let RunEvent::Exit = event {
            let (supervisor, expected_pid) = {
                let state = app_handle.state::<Mutex<DesktopService>>();
                let mut guard = state.lock().unwrap();
                (
                    guard.supervisor.take(),
                    guard.service_pid,
                )
            };

            let Some(mut child) = supervisor else {
                if let Some(expected_pid) = expected_pid {
                    request_server_shutdown(port, expected_pid);
                    if !wait_service_stopped(port, supervisor_grace()) {
                        eprintln!("[claw-desktop] attached Claw service is still listening after the shutdown grace; leaving it untouched");
                    }
                }
                return;
            };

            if matches!(child.try_wait(), Ok(Some(_))) {
                if let Some(expected_pid) = expected_pid {
                    request_server_shutdown(port, expected_pid);
                    if !wait_service_stopped(port, supervisor_grace()) {
                        eprintln!("[claw-desktop] Claw service is still listening after the shutdown grace; leaving it untouched");
                    }
                }
                return;
            }

            if let Some(expected_pid) = expected_pid {
                request_server_shutdown(port, expected_pid);
            }
            let deadline = Instant::now() + supervisor_grace();
            if expected_pid.is_some() {
                while Instant::now() < deadline {
                    if let Ok(Some(_)) = child.try_wait() {
                        return; // supervisor 已善后退出
                    }
                    std::thread::sleep(Duration::from_millis(150));
                }
            }
            eprintln!("[claw-desktop] supervisor still alive after grace, killing process tree");
            #[cfg(windows)]
            let _ = Command::new("taskkill")
                .args(["/PID", &child.id().to_string(), "/T", "/F"])
                .status();
            #[cfg(not(windows))]
            let _ = child.kill();
            let _ = child.wait();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_open_and_new_chat_requests() {
        let request = parse_open_request([
            "C:\\Apps\\AgentDevClaw.exe",
            "--claw-open=D:\\code\\my project",
        ]);
        assert_eq!(request.as_ref().map(|r| r.action), Some("open"));
        assert_eq!(request.map(|r| r.dir), Some("D:\\code\\my project".to_string()));

        let request = parse_open_request(["--claw-new-chat=D:\\dev"]);
        assert_eq!(request.as_ref().map(|r| r.action), Some("new-chat"));
        assert_eq!(request.map(|r| r.dir), Some("D:\\dev".to_string()));
    }

    #[test]
    fn last_occurrence_wins_and_empty_values_ignored() {
        let none = parse_open_request(["AgentDevClaw.exe", "--claw-open="]);
        assert!(none.is_none());
        let request = parse_open_request(["--claw-open=D:\\a", "--claw-new-chat=D:\\b"]);
        assert_eq!(request.as_ref().map(|r| (r.action, r.dir.as_str())), Some(("new-chat", "D:\\b")));
    }

    #[test]
    fn query_key_matches_frontend_contract() {
        let open = OpenRequest { action: "open", dir: String::new() };
        let new_chat = OpenRequest { action: "new-chat", dir: String::new() };
        assert_eq!(open.query_key(), "claw-open");
        assert_eq!(new_chat.query_key(), "claw-new-chat");
    }

    #[test]
    fn percent_encode_keeps_unreserved_and_encodes_path_bytes() {
        assert_eq!(percent_encode("D:\\code my-project_1.~z"), "D%3A%5Ccode%20my-project_1.~z");
        assert_eq!(percent_encode("中文"), "%E4%B8%AD%E6%96%87");
    }

    #[test]
    fn js_literal_escapes_backslash_quote_and_controls() {
        assert_eq!(js_string_literal("D:\\a\"b"), "D:\\\\a\\\"b");
        assert_eq!(js_string_literal("a\nb\u{1}"), "a\\nb\\u0001");
    }
}
