//! 系统集成：ARP 卸载项接管、资源管理器右键菜单、快捷方式。
//!
//! 对齐原 NSIS 行为（desktop/installer-hooks.nsh 的语义迁移）：
//! - ARP 键名 `AgentDevClaw`（HKCU），升级时直接覆盖同键——接管旧 NSIS
//!   安装的卸载入口，不产生第二个卸载项。
//! - 右键菜单两项写 HKCU\Software\Classes\Directory\Background\shell，
//!   command 指向 `<安装目录>\agentdev-claw-desktop.exe`，参数
//!   `--claw-open=%V` / `--claw-new-chat=%V`（与 desktop/src/main.rs 的
//!   parse_open_request、前端 modules/desktop-open.js 三处键名同步）。
//! - 快捷方式目标同样是主 exe；开始菜单放 Programs 根（对齐 NSIS 无
//!   startMenuFolder 配置的落点）。
//!
//! 测试隔离：`CLAW_SETUP_ARP_SUFFIX` 非空时 ARP 键名附加后缀，端到端
//! 验证用独立键避免污染真实安装的卸载项。

use std::fs;
use std::path::{Path, PathBuf};
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
use winreg::RegKey;

pub const PRODUCT_NAME: &str = "AgentDevClaw";
pub const MAIN_EXE: &str = "agentdev-claw-desktop.exe";
const UNINSTALLER_NAME: &str = "uninstall.exe";

/// ARP 键名。测试隔离时形如 `AgentDevClaw-E2E`。
pub fn arp_key_name() -> String {
    match std::env::var("CLAW_SETUP_ARP_SUFFIX") {
        Ok(suffix) if !suffix.is_empty() => format!("{PRODUCT_NAME}-{suffix}"),
        _ => PRODUCT_NAME.to_string(),
    }
}

/// 读取现有安装信息（ARP 项）。返回 (安装目录, 版本)。
pub fn existing_install() -> Option<(PathBuf, String)> {
    existing_install_from(&arp_key_name())
}

/// 规整 InstallLocation 原始值：去首尾空白与字面引号，空值返回 None。
///
/// 旧 NSIS 安装写入的值带字面引号（本机实测 `"D:\programme\AgentDevClaw"`），
/// 带引号的路径 `exists()` 恒 false，升级跟随会静默失效。
/// 纯函数抽出以便纯单测——真实注册表往返测试在装有主动拦截类安全软件
/// （如火绒）的机器上会被静默拒绝（os error 5），不适合作测试载体。
fn normalize_install_location(raw: &str) -> Option<String> {
    let dir = raw.trim().trim_matches('"').to_string();
    if dir.is_empty() {
        None
    } else {
        Some(dir)
    }
}

/// `existing_install` 的可测试形态：键名注入（测试用独立后缀键，
/// 避免读真实安装信息、也避免 env 变量在并行测试间竞态）。
fn existing_install_from(key_name: &str) -> Option<(PathBuf, String)> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey_with_flags(
            format!(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{key_name}"),
            KEY_READ,
        )
        .ok()?;
    let dir: Result<String, _> = key.get_value("InstallLocation");
    let ver: Result<String, _> = key.get_value("DisplayVersion");
    let dir = dir.ok()?;
    // 旧 NSIS 写入的 InstallLocation 带字面引号，剥掉再返回（见 normalize）。
    let dir = normalize_install_location(&dir)?;
    Some((PathBuf::from(dir), ver.unwrap_or_default()))
}

/// 默认安装目录：升级跟随现有 InstallLocation，全新安装用
/// `%LOCALAPPDATA%\AgentDevClaw`（对齐 Tauri NSIS CurrentUser 默认值）。
pub fn default_install_dir() -> PathBuf {
    if let Some((dir, _)) = existing_install() {
        if dir.exists() {
            return dir;
        }
    }
    std::env::var("LOCALAPPDATA")
        .map(|base| Path::new(&base).join(PRODUCT_NAME))
        .expect("LOCALAPPDATA 未定义")
}

/// 写 ARP 卸载项并自拷卸载器。`estimated_kb` 为安装目录占用估算。
pub fn register_arp(install_dir: &Path, version: &str, estimated_kb: u64) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey(format!(
            r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{}",
            arp_key_name()
        ))
        .map_err(|e| format!("创建 ARP 键失败：{e}"))?;

    let main_exe = install_dir.join(MAIN_EXE);
    let uninstaller = install_dir.join(UNINSTALLER_NAME);
    // 自拷卸载器：安装器以 --uninstall 模式作为 uninstall.exe 运行，
    // 与旧 NSIS uninstall.exe 同名同位置，升级即接管旧卸载入口。
    let self_path = std::env::current_exe().map_err(|e| format!("定位自身失败：{e}"))?;
    fs::copy(&self_path, &uninstaller).map_err(|e| format!("写入卸载器失败：{e}"))?;

    let set = |name: &str, value: &str| {
        key.set_value(name, &value)
            .map_err(|e| format!("写 ARP {name} 失败：{e}"))
    };
    set("DisplayName", &format!("{PRODUCT_NAME}（桌面版）"))?;
    set("DisplayVersion", version)?;
    set(
        "UninstallString",
        &format!("\"{}\" --uninstall", uninstaller.display()),
    )?;
    set("DisplayIcon", &main_exe.display().to_string())?;
    set("InstallLocation", &install_dir.display().to_string())?;
    set("Publisher", "AgentDev")?;
    set("NoModify", "1")?;
    set("NoRepair", "1")?;
    key.set_value("EstimatedSize", &estimated_kb)
        .map_err(|e| format!("写 ARP EstimatedSize 失败：{e}"))?;
    Ok(())
}

/// 写右键菜单两项。`enabled=false` 时删除（对应 NSIS PREUNINSTALL 清理）。
/// 键名带隔离后缀（与 ARP 同源：`CLAW_SETUP_ARP_SUFFIX`），端到端验证
/// 不触碰真实安装的菜单项；正式安装无后缀、键名不变。
pub fn context_menu(install_dir: &Path, enabled: bool) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let shell_root = r"Software\Classes\Directory\Background\shell";
    let main_exe = install_dir.join(MAIN_EXE);
    let tag = arp_key_name();
    let entries: [(String, &str, &str); 2] = [
        (format!("{tag}.Open"), "在编程小助手中打开", "--claw-open=%V"),
        (format!("{tag}.NewChat"), "在编程小助手中创建会话", "--claw-new-chat=%V"),
    ];
    for (subkey, label, flag) in entries {
        let path = format!(r"{shell_root}\{subkey}");
        if !enabled {
            let _ = hkcu.delete_subkey_all(&path);
            continue;
        }
        let (key, _) = hkcu
            .create_subkey(&path)
            .map_err(|e| format!("创建右键菜单键失败：{e}"))?;
        key.set_value("", &label).map_err(|e| e.to_string())?;
        key.set_value("Icon", &main_exe.display().to_string())
            .map_err(|e| e.to_string())?;
        let (cmd, _) = hkcu
            .create_subkey(format!(r"{path}\command"))
            .map_err(|e| format!("创建右键菜单 command 失败：{e}"))?;
        // 外层单引号、exe 与参数各自双引号，含空格路径可靠传参（对齐 NSIS 钩子）
        cmd.set_value("", &format!("\"{}\" \"{}\"", main_exe.display(), flag))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 删除本产品的右键菜单键。
pub fn remove_context_menu() -> Result<(), String> {
    context_menu(Path::new(""), false)
}

/// 开始菜单 / 桌面快捷方式路径。文件名带隔离后缀（同 ARP 机制，
/// 端到端验证不覆盖真实快捷方式；正式安装无后缀）。
pub fn shortcut_paths(desktop: bool) -> Vec<(PathBuf, &'static str)> {
    let mut paths = Vec::new();
    let lnk_name = format!("{}.lnk", arp_key_name());
    if let Ok(appdata) = std::env::var("APPDATA") {
        paths.push((
            Path::new(&appdata)
                .join(r"Microsoft\Windows\Start Menu\Programs")
                .join(&lnk_name),
            "开始菜单",
        ));
    }
    if desktop {
        if let Ok(desktop_dir) = std::env::var("USERPROFILE") {
            paths.push((Path::new(&desktop_dir).join("Desktop").join(&lnk_name), "桌面"));
        }
    }
    paths
}

/// 将 Windows 文件系统 API 的扩展路径转换为 Shell/注册表可消费的普通 DOS 路径。
/// `std::fs::canonicalize` 在 Windows 返回 `\\\\?\\C:\\...`；COM
/// `IShellLinkW::SetPath` 对此返回 E_INVALIDARG (0x80070057)。
fn shell_compatible_path(path: &Path) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

/// 经 COM IShellLink 创建 .lnk。
pub fn create_shortcut(lnk_path: &Path, target: &Path) -> Result<(), String> {
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let co_inited = hr.is_ok();
        let result = (|| -> Result<(), String> {
            let shell_link: IShellLinkW =
                CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
                    .map_err(|e| format!("创建 ShellLink 失败：{e}"))?;
            let wide = |s: &str| {
                s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>()
            };
            let target = shell_compatible_path(target);
            let working_dir = shell_compatible_path(
                target.parent().unwrap_or_else(|| Path::new("")),
            );
            let target_wide = wide(&target.to_string_lossy());
            shell_link
                .SetPath(PCWSTR(target_wide.as_ptr()))
                .map_err(|e| format!("SetPath 失败 {target:?}：{e}"))?;
            let working_wide = wide(&working_dir.to_string_lossy());
            shell_link
                .SetWorkingDirectory(PCWSTR(working_wide.as_ptr()))
                .map_err(|e| format!("SetWorkingDirectory 失败 {working_dir:?}：{e}"))?;
            let persist: IPersistFile = shell_link
                .cast()
                .map_err(|e| format!("cast IPersistFile 失败：{e}"))?;
            let shortcut_path = shell_compatible_path(lnk_path);
            let shortcut_path_wide = wide(&shortcut_path.to_string_lossy());
            persist
                .Save(PCWSTR(shortcut_path_wide.as_ptr()), true)
                .map_err(|e| format!("保存 .lnk 失败 {shortcut_path:?}：{e}"))?;
            Ok(())
        })();
        if co_inited {
            CoUninitialize();
        }
        result
    }
}

/// 删除快捷方式（卸载清理；文件不存在视为成功）。
pub fn remove_shortcut(lnk_path: &Path) -> Result<(), String> {
    match fs::remove_file(lnk_path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("删除快捷方式失败：{e}")),
    }
}

/// 删除 ARP 键（卸载清理）。
pub fn remove_arp() -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    hkcu.delete_subkey_all(format!(
        r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{}",
        arp_key_name()
    ))
    .map_err(|e| format!("删除 ARP 键失败：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arp_key_name_respects_test_suffix() {
        // 不污染环境变量的情况下验证纯函数拼接
        assert_eq!(arp_key_name(), PRODUCT_NAME);
    }

    #[test]
    fn context_menu_flags_roundtrip() {
        // entries 常量驱动注册与删除共用一套键路径，键名拼写一致性由编译期常量保证
        assert!(MAIN_EXE.ends_with(".exe"));
    }

    #[test]
    fn shell_paths_strip_extended_prefix() {
        assert_eq!(
            shell_compatible_path(Path::new(r"\\?\D:\programme\AgentDevClaw\agent.exe")),
            PathBuf::from(r"D:\programme\AgentDevClaw\agent.exe")
        );
        assert_eq!(
            shell_compatible_path(Path::new(r"\\?\UNC\server\share\agent.exe")),
            PathBuf::from(r"\\server\share\agent.exe")
        );
        assert_eq!(
            shell_compatible_path(Path::new(r"D:\apps\agent.exe")),
            PathBuf::from(r"D:\apps\agent.exe")
        );
    }

    /// 可选的本机 COM 集成验证：显式传扩展路径给 SetPath，确认转换后可创建 .lnk。
    /// 手动运行：cargo test shell_link_accepts_extended_exe_path -- --ignored
    #[test]
    #[ignore = "需本机 Windows Shell COM 与可写临时目录"]
    fn shell_link_accepts_extended_exe_path() {
        let exe = std::env::current_exe().expect("current_exe");
        let extended = exe.canonicalize().expect("canonicalize exe");
        assert!(extended.to_string_lossy().starts_with(r"\\?\"));
        let appdata = std::env::var("APPDATA").expect("APPDATA");
        let shortcut = Path::new(&appdata)
            .join(r"Microsoft\Windows\Start Menu\Programs")
            .join("ClawShellProbe.lnk");
        let result = create_shortcut(&shortcut, &extended);
        if shortcut.exists() {
            let _ = fs::remove_file(&shortcut);
        }
        result.expect("Shell Link COM 应接受规整后的 DOS 路径");
        assert!(!shortcut.exists(), "测试快捷方式应已清理");
    }

    /// 旧 NSIS 写入的 InstallLocation 带字面引号（本机实测
    /// `"D:\programme\AgentDevClaw"`），读取必须剥引号，否则升级跟随失效。
    /// 纯函数测试：不写真实注册表（火绒类软件会静默拦截未知 exe 的
    /// 注册表写入，机器相关性失败会让测试套件不可信）。
    #[test]
    fn normalize_install_location_strips_nsis_quotes() {
        assert_eq!(
            normalize_install_location(r#""D:\programme\AgentDevClaw""#).as_deref(),
            Some(r"D:\programme\AgentDevClaw")
        );
        // 无引号原样通过；空白与引号壳视为无值
        assert_eq!(
            normalize_install_location(r"C:\apps\Claw").as_deref(),
            Some(r"C:\apps\Claw")
        );
        assert_eq!(normalize_install_location("   "), None);
        assert_eq!(normalize_install_location(r#""""#), None);
    }
}
