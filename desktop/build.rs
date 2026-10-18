fn main() {
    // app 自定义命令也受 Tauri v2 ACL 管（remote 页面 invoke 未声明即
    // "not allowed by ACL"）：在此声明命令生成 allow-* 权限，再由
    // capabilities/*.json 授权给对应窗口（persistent_notification →
    // main-window；resolve_close_choice → close-confirm-window）。
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["persistent_notification", "resolve_close_choice"]),
        ),
    )
    .expect("failed to run tauri-build");
}
