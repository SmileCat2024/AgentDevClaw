//! 运行中进程守卫：安装/卸载前检测主程序与 sidecar node 进程并结束。
//!
//! 检测分两类：
//! - `agentdev-claw-desktop.exe`：映像名全局唯一，按名匹配即可。
//! - `node.exe`：开发机上大量无关 node 进程，必须按「可执行路径位于
//!   安装目录下」过滤，绝不能按名全局杀。
//!
//! 实现走 PowerShell CIM 查询（带路径），结果经 `ConvertTo-Json` 交给
//! Rust 解析——不手拼 JSON 模板，避开 Rust `format!` 与 PowerShell `-f`
//! 两层花括号转义叠加。结束用 taskkill /T /F 收进程树。
//!
//! 调用方传普通绝对路径（不带 `\\?\` 长路径前缀）：CIM 返回的
//! ExecutablePath 是普通形态，带前缀会导致 `-like` 匹配全部落空。

use std::path::Path;
use std::process::{Command, Stdio};

const MAIN_EXE: &str = "agentdev-claw-desktop.exe";

#[derive(Debug, Clone, serde::Serialize)]
pub struct RunningProcess {
    pub pid: u32,
    pub name: String,
    pub path: String,
}

/// 查询与安装目录相关的运行中进程。
pub fn detect(install_dir: &Path) -> Vec<RunningProcess> {
    let dir = install_dir.to_string_lossy().replace('\'', "''");
    // 主 exe 按名匹配 + node 按路径前缀匹配，一次查询合并结果。
    // 花括号在 Rust format! 里写作 {{（字面量），脚本自身无位置占位符。
    let script = format!(
        r#"
        $hits = @()
        $hits += Get-CimInstance Win32_Process -Filter "Name = '{MAIN_EXE}'" -ErrorAction SilentlyContinue
        $node = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
            Where-Object {{ $_.ExecutablePath -like '{dir}\*' }}
        $hits += $node
        $hits | Where-Object {{ $_.ProcessId }} |
            Select-Object ProcessId, Name, ExecutablePath |
            ConvertTo-Json -Compress
        "#
    );
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output();
    match output {
        Ok(out) if out.status.success() => parse_json_stdout(&String::from_utf8_lossy(&out.stdout)),
        _ => Vec::new(),
    }
}

/// 解析 ConvertTo-Json 输出：空管道无输出；单条是对象；多条是数组。
fn parse_json_stdout(stdout: &str) -> Vec<RunningProcess> {
    let text = stdout.trim();
    if text.is_empty() {
        return Vec::new();
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let items = match value {
        serde_json::Value::Array(items) => items,
        one @ serde_json::Value::Object(_) => vec![one],
        _ => return Vec::new(),
    };
    items
        .iter()
        .filter_map(|item| {
            let pid = item.get("ProcessId")?.as_u64()? as u32;
            let name = item.get("Name")?.as_str()?.to_string();
            // ExecutablePath 可能为 null（提权前的系统进程），视为无路径
            let path = item
                .get("ExecutablePath")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Some(RunningProcess { pid, name, path })
        })
        .collect()
}

/// 结束给定进程（整棵进程树）。
pub fn kill_all(procs: &[RunningProcess]) {
    for p in procs {
        let _ = Command::new("taskkill")
            .args(["/PID", &p.pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_converttojson_output() {
        // 多条：数组形态
        let array_out = r#"[{"ProcessId":123,"Name":"node.exe","ExecutablePath":"D:\\dir\\node.exe"},{"ProcessId":456,"Name":"agentdev-claw-desktop.exe","ExecutablePath":"D:\\dir\\a.exe"}]"#;
        let procs = parse_json_stdout(array_out);
        assert_eq!(procs.len(), 2);
        assert_eq!(procs[0].pid, 123);
        assert_eq!(procs[1].name, "agentdev-claw-desktop.exe");

        // 单条：对象形态（ConvertTo-Json 管道只有一项时不包数组）
        let single_out = r#"{"ProcessId":789,"Name":"node.exe","ExecutablePath":null}"#;
        let procs = parse_json_stdout(single_out);
        assert_eq!(procs.len(), 1);
        assert_eq!(procs[0].pid, 789);
        assert_eq!(procs[0].path, "");

        // 空 / 非 JSON：空列表
        assert!(parse_json_stdout("").is_empty());
        assert!(parse_json_stdout("noise").is_empty());
    }
}
