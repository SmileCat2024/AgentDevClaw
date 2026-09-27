// Claw 桌面壳（Tauri）。
//
// 桌面进程启动并观察服务（见 docs/protocols/service-lifecycle.md）：
//   启动：spawn supervisor，supervisor 只做日志和只读健康探测
//   就绪：等服务端口可连接后再建窗口，避免 webview 停在连接错误页
//   退出：窗口关闭 → POST /protoclaw/shutdown 让 server 自主有序关闭；
//         显式退出等待超时后仅由本桌面宿主清理自己创建的服务子树
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

fn spawn_supervisor() -> std::io::Result<Child> {
    let repo_root = repo_root();
    let mut cmd = node_command();
    cmd.args(["scripts/run-supervised.js"])
        .current_dir(&repo_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
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
        let addr = format!("127.0.0.1:{port}").parse().expect("loopback addr");
        if TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

/// 请求 server 自主有序关闭（SSE 通知、runtime 停机、端口释放在 server 侧完成）。
/// 请求失败不阻塞；显式退出期限后的子进程清理由本桌面宿主负责。
fn request_server_shutdown(port: u16) {
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

fn main() {
    let app = tauri::Builder::default()
        .on_window_event(|window, event| {
            // 退出由主窗口的关闭意图显式裁决，不依赖"最后一个窗口关闭"——
            // Windows 会向本进程挂靠辅助顶层窗口（IME、ConPTY 的
            // PseudoConsoleWindow 等），后者存活时 last-window 语义永不触发
            // （实测：WM_CLOSE 后主窗销毁、进程不退）。exit(0) 走既有
            // ExitRequested → Exit 清理链。
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    window.app_handle().exit(0);
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let port = service_port();
            let supervisor: Mutex<Option<Child>> = Mutex::new(match spawn_supervisor() {
                Ok(child) => Some(child),
                Err(err) => {
                    eprintln!("[claw-desktop] spawn supervisor failed: {err}");
                    None
                }
            });
            app.manage(supervisor);

            // 窗口创建必须经事件循环（AppHandle 代理）投递；在 run() 启动前的
            // 主线程上直接 build 会因 WebView2 初始化等不到循环分发而挂死（实测）。
            std::thread::spawn(move || {
                if !wait_service_ready(port, Duration::from_secs(15)) {
                    eprintln!("[claw-desktop] service not ready on port {port} after 15s, opening window anyway");
                }
                let url: tauri::Url = format!("http://127.0.0.1:{port}/")
                    .parse()
                    .expect("service url");
                if let Err(err) = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(url))
                    .title("AgentDevClaw")
                    .inner_size(1600.0, 1000.0)
                    .min_inner_size(1100.0, 700.0)
                    .build()
                {
                    eprintln!("[claw-desktop] failed to create main window: {err}");
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    let port = service_port();
    app.run(move |app_handle, event| {
        if let RunEvent::Exit = event {
            let guard = app_handle.state::<Mutex<Option<Child>>>();
            let Some(mut child) = guard.lock().unwrap().take() else {
                return;
            };
            request_server_shutdown(port);
            let deadline = Instant::now() + supervisor_grace();
            while Instant::now() < deadline {
                if let Ok(Some(_)) = child.try_wait() {
                    return; // supervisor 已善后退出
                }
                std::thread::sleep(Duration::from_millis(150));
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
