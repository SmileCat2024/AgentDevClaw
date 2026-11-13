//! 卸载流程与清理善后。
//!
//! 自删套路：运行中的 uninstall.exe 无法删除所在安装目录，卸载器先把
//! 自身拷到 %TEMP%，由副本进程（--cleanup-dir 模式）延迟删除整个安装
//! 目录，最后经 cmd 延迟命令删除副本自身。

use crate::integrate;
use crate::install::{self, Progress};
use crate::procguard;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::Receiver;

/// 执行完整卸载。`kill_confirm` 语义与安装相同。
pub fn run(sink: &install::Sink, install_dir: &Path, kill_confirm: Receiver<bool>) -> Result<(), String> {
    // 1. 进程守卫
    let running = procguard::detect(install_dir);
    if !running.is_empty() {
        install::emit_progress(sink, Progress::ConfirmKill { processes: running.clone() });
        match kill_confirm.recv() {
            Ok(true) => procguard::kill_all(&running),
            _ => return Err("已取消卸载".into()),
        }
    }

    // 2. 注册表清理：右键菜单 + ARP（先摘除，目录删除失败也能从控制面板重试）
    install::emit_progress(sink, Progress::Integrating);
    integrate::remove_context_menu()?;
    for (lnk, _) in integrate::shortcut_paths(true) {
        let _ = integrate::remove_shortcut(&lnk);
    }
    integrate::remove_arp()?;

    // 3. 自拷 %TEMP% 并由副本删除安装目录
    let self_path = std::env::current_exe().map_err(|e| format!("定位自身失败：{e}"))?;
    let temp = std::env::temp_dir().join(format!(
        "claw-uninstaller-{}.exe",
        std::process::id()
    ));
    std::fs::copy(&self_path, &temp).map_err(|e| format!("准备清理进程失败：{e}"))?;
    Command::new(&temp)
        .arg(format!("--cleanup-dir={}", install_dir.display()))
        .spawn()
        .map_err(|e| format!("启动清理进程失败：{e}"))?;

    install::emit_progress(sink, Progress::Done);
    Ok(())
}

/// `--cleanup-dir` 模式：等待原卸载器退出后删除安装目录，再自删。
pub fn cleanup_dir(dir: &Path) {
    use crate::install::long_path;
    // 原卸载器进程尚未退出时安装目录里的 uninstall.exe 仍被占用
    std::thread::sleep(std::time::Duration::from_millis(800));
    // 删除走长路径前缀：node_modules 深层嵌套同样会超 260 字符限制
    let _ = std::fs::remove_dir_all(long_path(dir));
    // 自删：cmd 延迟删除当前副本（ping 计时期间本进程退出，del 才能成功）
    let self_path = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("unknown"));
    let cleanup_line =
        format!("ping -n 2 127.0.0.1 >NUL & del /F /Q \"{}\"", self_path.display());
    let _ = Command::new("cmd")
        .args(["/C", &cleanup_line])
        .creation_flags_detached();
}

trait Detached {
    fn creation_flags_detached(&mut self) -> &mut Self;
}

impl Detached for Command {
    #[cfg(windows)]
    fn creation_flags_detached(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS：不继承卸载器即将关闭的控制台/句柄
        self.creation_flags(0x0000_0008);
        self
    }
    #[cfg(not(windows))]
    fn creation_flags_detached(&mut self) -> &mut Self {
        self
    }
}
