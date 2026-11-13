//! 安装状态机：解压 payload → 系统集成 → 快捷方式，进度经事件推送到 UI。
//!
//! 布局约定（与 NSIS 时代完全一致，升级无缝）：
//! ```text
//! <安装目录>\agentdev-claw-desktop.exe   ← payload zip 根（构建脚本放入）
//! <安装目录>\app\...                     ← payload zip 的 staging 树
//! <安装目录>\uninstall.exe               ← 集成阶段自拷
//! ```
//! 覆盖升级语义对齐原 NSIS 钩子：解压前清 `app\guide`（纯分发资产，
//! 旧版残留会被指南目录树实时扫描成新旧混合侧栏）。

use crate::integrate;
use crate::payload;
use crate::procguard;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use tauri::Emitter;
use zip::ZipArchive;

#[derive(Debug, Deserialize)]
pub struct InstallOptions {
    pub install_dir: String,
    #[serde(rename = "desktopShortcut")]
    pub desktop_shortcut: bool,
    #[serde(rename = "contextMenu")]
    pub context_menu: bool,
    #[serde(rename = "startMenuShortcut")]
    pub start_menu_shortcut: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "phase")]
pub enum Progress {
    /// 等待用户确认结束运行中的进程
    ConfirmKill { processes: Vec<procguard::RunningProcess> },
    Extracting { detail: String, pct: u8 },
    Integrating,
    Shortcuts,
    Done,
    Error { message: String },
}

/// 进度出口：向导 UI（Tauri 事件）或控制台（--cli 模式）。
pub enum Sink {
    Ui(tauri::AppHandle),
    Console,
}

impl Sink {
    pub fn emit(&self, progress: &Progress) {
        match self {
            Sink::Ui(app) => {
                let _ = app.emit("install-progress", progress);
            }
            Sink::Console => {
                if let Progress::Extracting { detail, pct } = progress {
                    // 控制台节流：只打印整 5% 台阶，避免刷屏
                    if pct % 5 == 0 {
                        println!("[{pct:3}%] {detail}");
                    }
                }
            }
        }
    }
}

pub fn emit_progress(sink: &Sink, progress: Progress) {
    sink.emit(&progress);
}

/// 执行完整安装。`kill_confirm` 在检测到运行中进程时等待确认
/// （`true` = 结束进程并继续，`false` = 取消安装）。
pub fn run(sink: &Sink, opts: &InstallOptions, version: &str, kill_confirm: Receiver<bool>) -> Result<(), String> {
    let install_dir = PathBuf::from(&opts.install_dir);
    std::fs::create_dir_all(&install_dir).map_err(|e| format!("创建安装目录失败：{e}"))?;
    // 双路径形态：plain（C:\...）给注册表 / PowerShell / 快捷方式 —— 这些
    // 消费方期望普通路径；long（\\?\C:\...）给文件系统写入 —— node_modules
    // 深层嵌套超过 260 字符限制时，无前缀的 std::fs 调用会静默失败。
    let plain_dir = install_dir
        .canonicalize()
        .map_err(|e| format!("解析安装目录失败：{e}"))?;
    let install_dir = long_path(&plain_dir);

    // 1. 进程守卫：检测 → 确认 → 结束（CIM 路径匹配需要普通路径）
    let running = procguard::detect(&plain_dir);
    if !running.is_empty() {
        emit_progress(sink, Progress::ConfirmKill { processes: running.clone() });
        match kill_confirm.recv() {
            Ok(true) => procguard::kill_all(&running),
            _ => return Err("已取消安装".into()),
        }
    }

    // 2. payload 读取
    let zip_bytes = payload::read().map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(std::io::Cursor::new(zip_bytes))
        .map_err(|e| format!("payload 损坏（无法打开 zip）：{e}"))?;
    let total_bytes: u64 = (0..archive.len())
        .map(|i| archive.by_index(i).map(|f| f.size()).unwrap_or(0))
        .sum();

    // 3. 覆盖升级清理（NSIS PREINSTALL 语义）
    let guide_dir = install_dir.join("app").join("guide");
    if guide_dir.exists() {
        let _ = std::fs::remove_dir_all(&guide_dir);
    }

    // 4. 解压（按累计字节推进进度）
    let mut done_bytes: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取 zip 条目失败：{e}"))?;
        let entry_path = match entry.enclosed_name() {
            Some(p) => p.to_path_buf(),
            // zip-slip：条目名逃逸出目标目录（../ 或绝对路径），拒绝落盘
            None => continue,
        };
        let dest = install_dir.join(&entry_path);
        if entry.is_dir() {
            std::fs::create_dir_all(&dest).map_err(|e| format!("创建目录失败 {dest:?}：{e}"))?;
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败 {parent:?}：{e}"))?;
        }
        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("解压失败 {dest:?}：{e}"))?;
        std::fs::write(&dest, &buf).map_err(|e| format!("写入失败 {dest:?}：{e}（目标可能被占用）"))?;
        done_bytes += buf.len() as u64;
        let pct = if total_bytes > 0 { ((done_bytes * 100) / total_bytes) as u8 } else { 100 };
        emit_progress(
            sink,
            Progress::Extracting { detail: entry_path.display().to_string(), pct },
        );
    }

    // 5. 系统集成：ARP（含卸载器自拷） + 右键菜单（注册表值用普通路径）
    emit_progress(sink, Progress::Integrating);
    let main_exe = install_dir.join(integrate::MAIN_EXE);
    if !main_exe.exists() {
        return Err(format!("payload 缺少主程序 {}（构建链拼接错误）", integrate::MAIN_EXE));
    }
    let estimated_kb = dir_size_kb(&install_dir);
    integrate::register_arp(&plain_dir, version, estimated_kb)?;
    if opts.context_menu {
        integrate::context_menu(&plain_dir, true)?;
    }

    // 6. 快捷方式（.lnk 目标必须是普通路径）
    emit_progress(sink, Progress::Shortcuts);
    let main_exe_plain = plain_dir.join(integrate::MAIN_EXE);
    if opts.start_menu_shortcut || opts.desktop_shortcut {
        for (lnk, _) in integrate::shortcut_paths(opts.desktop_shortcut) {
            integrate::create_shortcut(&lnk, &main_exe_plain)?;
        }
    }

    emit_progress(sink, Progress::Done);
    Ok(())
}

/// 目录占用估算（KB），写入 ARP EstimatedSize。
pub fn dir_size_kb(dir: &Path) -> u64 {
    fn walk(dir: &Path, acc: &mut u64) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                walk(&entry.path(), acc);
            } else {
                *acc += meta.len();
            }
        }
    }
    let mut bytes = 0u64;
    walk(dir, &mut bytes);
    bytes / 1024
}

/// 为本地绝对路径加 `\\?\` 长路径前缀。
///
/// 安装到 `%LOCALAPPDATA%` 后，`app\node_modules` 深层嵌套极易超过
/// Windows 260 字符路径限制，无前缀的 std::fs 调用会静默失败。本产品
/// 不支持 UNC 安装目录（\\?\UNC\ 形态暂不处理）。
pub fn long_path(p: &Path) -> PathBuf {
    let s = p.display().to_string();
    if s.starts_with(r"\\?\") || s.starts_with(r"\\") {
        return PathBuf::from(s);
    }
    PathBuf::from(format!(r"\\?\{s}"))
}
