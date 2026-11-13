//! Windows exe manifest：release 构建要求管理员权限（requireAdministrator）。
//!
//! 为什么：默认安装目标是受保护目录（用户自选如 D:\programme）时普通权限
//! 写入会在解压中途失败卡住；卸载 / --cleanup-dir 删除安装目录同样需要
//! 提升。管理员安装是与用户对齐的安装方式，安装 / 卸载 / 静默安装全部
//! 形态一致提权，行为可预期（exe 属性页可见"以管理员身份运行此程序"）。
//!
//! debug 构建保持默认 asInvoker：开发调试不必每次弹 UAC。
//! 注意构建链 build-desktop-installer.mjs 的 --selfcheck 是 node 侧等价校验
//! （读尾部布局 + bsdtar 解析），不启动安装器进程，构建全程无需 UAC。
//!
//! manifest 必须保留 Common-Controls v6 依赖：tauri-plugin-dialog 的目录
//! 选择对话框需要（tauri-build 文档明示自定义 manifest 时必须自带）。

const MANIFEST: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="requireAdministrator" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#;

fn main() {
    let attributes = if std::env::var("PROFILE").as_deref() == Ok("release") {
        tauri_build::Attributes::new().windows_attributes(
            tauri_build::WindowsAttributes::new().app_manifest(MANIFEST),
        )
    } else {
        tauri_build::Attributes::default()
    };
    if let Err(error) = tauri_build::try_build(attributes) {
        let error = format!("{error:#}");
        println!("{error}");
        std::process::exit(1);
    }
}
