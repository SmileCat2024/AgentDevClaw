//! AgentDevClaw 桌面版安装器（自研，替代 Tauri NSIS 模板）。
//!
//! 运行模式（argv 分发）：
//! - 无参数            安装向导 UI（Tauri 无边框窗口）
//! - `--uninstall`     卸载 UI（由 ARP「卸载」或安装目录 uninstall.exe 调起）
//! - `--cli`           控制台静默安装（默认选项；WebView2 不可用时的兜底与
//!                     自动化口子，对应原 NSIS /S）；`--dir=<路径>` 覆盖
//!                     目标目录（隔离端到端验证与自动化用，不跟随现有安装）
//! - `--selfcheck`     构建链自检：校验 SFX payload 完整性并打印摘要后退出
//! - `--cleanup-dir=D` 卸载善后（%TEMP% 副本进程专用）
//!
//! 设计记录见仓库 docs（SFX 格式 / ARP 接管 / 升级语义）。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod install;
mod integrate;
mod payload;
mod procguard;
mod uninstall;

use install::InstallOptions;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use tauri::State;

/// 进程确认通道：安装/卸载线程 emit ConfirmKill 后在此等待前端回执。
struct KillConfirm(Mutex<Option<Sender<bool>>>);

#[tauri::command]
fn get_mode() -> String {
    if std::env::args().any(|a| a == "--uninstall") {
        "uninstall".into()
    } else {
        "install".into()
    }
}

#[tauri::command]
fn get_install_state() -> serde_json::Value {
    let existing = integrate::existing_install();
    serde_json::json!({
        "installed": existing.is_some(),
        "installDir": existing.as_ref().map(|(d, _)| d.display().to_string()),
        "currentVersion": existing.as_ref().map(|(_, v)| v.clone()),
        "defaultDir": integrate::default_install_dir().display().to_string(),
        "targetVersion": env!("CARGO_PKG_VERSION"),
    })
}

#[tauri::command]
fn begin_install(app: tauri::AppHandle, state: State<KillConfirm>, opts: InstallOptions) -> Result<(), String> {
    let (tx, rx) = channel::<bool>();
    *state.0.lock().unwrap() = Some(tx);
    let version = app.package_info().version.to_string();
    std::thread::spawn(move || {
        let sink = install::Sink::Ui(app);
        if let Err(message) = install::run(&sink, &opts, &version, rx) {
            install::emit_progress(&sink, install::Progress::Error { message });
        }
    });
    Ok(())
}

#[tauri::command]
fn confirm_kill(state: State<KillConfirm>, proceed: bool) -> Result<(), String> {
    let sender = state.0.lock().unwrap().take();
    match sender {
        Some(tx) => tx.send(proceed).map_err(|_| "安装流程已退出".into()),
        None => Err("当前没有等待确认的流程".into()),
    }
}

#[tauri::command]
fn begin_uninstall(app: tauri::AppHandle, state: State<KillConfirm>) -> Result<(), String> {
    let install_dir = integrate::existing_install()
        .map(|(d, _)| d)
        .ok_or_else(|| "未找到已安装的 AgentDevClaw".to_string())?;
    let (tx, rx) = channel::<bool>();
    *state.0.lock().unwrap() = Some(tx);
    std::thread::spawn(move || {
        let sink = install::Sink::Ui(app);
        if let Err(message) = uninstall::run(&sink, &install_dir, rx) {
            install::emit_progress(&sink, install::Progress::Error { message });
        }
    });
    Ok(())
}

#[tauri::command]
fn launch_app() -> Result<(), String> {
    let dir = integrate::existing_install()
        .map(|(d, _)| d)
        .ok_or_else(|| "未找到安装目录".to_string())?;
    let exe = dir.join(integrate::MAIN_EXE);
    std::process::Command::new(&exe)
        .current_dir(&dir)
        .spawn()
        .map_err(|e| format!("启动失败：{e}"))?;
    Ok(())
}

/// `--selfcheck`：校验 payload 并输出摘要（供构建链拼接后验证）。
fn selfcheck() -> i32 {
    match payload::locate() {
        Ok(Some(meta)) => {
            // zip 中央目录可读才算完整
            let readable = payload::read()
                .ok()
                .and_then(|bytes| {
                    zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok().map(|a| a.len())
                });
            match readable {
                Some(entries) => {
                    println!(
                        "{{\"ok\":true,\"payloadBytes\":{},\"zipEntries\":{}}}",
                        meta.len, entries
                    );
                    0
                }
                None => {
                    println!("{{\"ok\":false,\"error\":\"payload zip 无法解析\"}}");
                    1
                }
            }
        }
        Ok(None) => {
            println!("{{\"ok\":false,\"error\":\"no payload\"}}");
            1
        }
        Err(e) => {
            println!("{{\"ok\":false,\"error\":\"{e}\"}}");
            1
        }
    }
}

/// `--cli`：控制台静默安装（默认选项：右键菜单 + 开始菜单，不建桌面快捷方式）。
/// `--dir=<路径>` 覆盖目标目录（隔离验证/自动化）；缺省走默认目录（升级跟随）。
fn cli_install(args: &[String]) -> i32 {
    let dir = args
        .iter()
        .find_map(|a| a.strip_prefix("--dir="))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(integrate::default_install_dir);
    println!("安装到 {} ...", dir.display());
    let opts = InstallOptions {
        install_dir: dir.display().to_string(),
        desktop_shortcut: false,
        context_menu: true,
        start_menu_shortcut: true,
    };
    // 无 UI：检测到运行中进程直接结束（静默模式的既定语义）
    let (tx, rx): (Sender<bool>, Receiver<bool>) = channel();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(150));
        let _ = tx.send(true);
    });
    let sink = install::Sink::Console;
    match install::run(&sink, &opts, env!("CARGO_PKG_VERSION"), rx) {
        Ok(()) => {
            println!("安装完成。");
            0
        }
        Err(e) => {
            eprintln!("安装失败：{e}");
            1
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    for arg in &args {
        if arg == "--selfcheck" {
            std::process::exit(selfcheck());
        }
        if let Some(dir) = arg.strip_prefix("--cleanup-dir=") {
            uninstall::cleanup_dir(std::path::Path::new(dir));
            return;
        }
    }

    if args.iter().any(|a| a == "--cli") {
        std::process::exit(cli_install(&args));
    }

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(KillConfirm(Mutex::new(None)))
        .setup(|app| {
            // 窗口在代码里建（不走 tauri.conf.json 的 windows 声明）：
            // 需要显式指定 WebView2 数据目录。两个坑：
            // 1. tauri 默认派生目录 %LOCALAPPDATA%\{identifier} 在本机
            //    创建被拒（os error 5，实测复现）；显式指定即正常。
            // 2. 不用 std::env::temp_dir()：Git bash 下 TEMP=/tmp 会被
            //    Windows 进程解析到当前盘根（D:\tmp），ACL 拒绝写入。
            // 安装器是短生命周期工具，数据目录放 exe 同级 .webview-data，
            // 随卸载/覆盖升级一并清理。
            let data_dir = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.join(".webview-data")))
                .unwrap_or_else(|| std::path::PathBuf::from(".webview-data"));
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::default(),
            )
            .title("AgentDevClaw 安装向导")
            .inner_size(780.0, 540.0)
            .resizable(false)
            .center()
            .decorations(false)
            .disable_drag_drop_handler()
            .data_directory(data_dir)
            .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_mode,
            get_install_state,
            begin_install,
            confirm_kill,
            begin_uninstall,
            launch_app
        ]);

    if let Err(e) = builder.run(tauri::generate_context!()) {
        // WebView2 不可用等致命初始化失败：指引安装 WebView2 Runtime，
        // 并提示可用 --cli 模式完成安装（对应原 NSIS /S 兜底）。
        eprintln!("[claw-setup] 窗口初始化失败：{e}");
        eprintln!("[claw-setup] 请安装 Microsoft Edge WebView2 Runtime 后重试，");
        eprintln!("[claw-setup] 或使用静默模式：{} --cli", args.first().unwrap_or(&"setup.exe".into()));
        std::process::exit(2);
    }
}
