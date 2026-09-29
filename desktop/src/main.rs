// Claw 桌面壳（Tauri）。
//
// 桌面进程启动并观察服务（见 docs/protocols/service-lifecycle.md）：
//   启动：先检查本机是否已有 ready 服务；有则只恢复前台，无则 spawn supervisor
//   单实例：重复运行 exe 只激活已有实例（聚焦主窗口），第二实例随即退出
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
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// WebView 权限只对本壳托管的 Claw 服务源自动放行；窗口内一旦导航到
/// 外部站点，回落 WebView2 默认行为，不替外部源背书权限。
fn is_service_origin(url: &tauri::Url) -> bool {
    url.host_str() == Some("127.0.0.1") && url.port() == Some(service_port())
}

fn main() {
    let app = tauri::Builder::default()
        // 单实例：须最先注册。第二实例把激活转交给已运行实例后自行退出，
        // 不进入 setup（不重复探测服务 / spawn supervisor）。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
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
        .setup(|app| {
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
            std::thread::spawn(move || {
                let service_ready = wait_service_ready(port, Duration::from_secs(15));
                if !service_ready {
                    eprintln!("[claw-desktop] Claw service not ready on port {port} after 15s; opening the window so the startup problem remains visible");
                }
                let url: tauri::Url = format!("http://127.0.0.1:{port}/")
                    .parse()
                    .expect("service url");
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
