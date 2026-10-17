fn main() {
    // app 自定义命令也受 Tauri v2 ACL 管（remote 页面 invoke 未声明即
    // "not allowed by ACL"）：声明命令生成 allow-persistent_notification，
    // 再由 capabilities/main-window.json 授权给服务源页面。
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["persistent_notification"]),
        ),
    )
    .expect("failed to run tauri-build");
}
