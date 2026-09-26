// 2a 渲染兼容性切片：窗口直接加载本机 Claw 服务（http://127.0.0.1:1420），
// 验证 WebView2 对现有前端的渲染兼容性。sidecar 托管、打包、图标与系统集
// 成属于后续切片，刻意不引入。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
