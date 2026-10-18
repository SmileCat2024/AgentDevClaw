; AgentDevClaw NSIS 安装器钩子 —— Windows 资源管理器右键菜单集成
;
; 注册 HKCU\Software\Classes\Directory\Background\shell 两个入口：
;   「在编程小助手中打开」    --claw-open=%V      切到编程小助手并定位该目录
;   「在编程小助手中创建会话」 --claw-new-chat=%V  切到编程小助手并在该目录新建对话
;
; 约定：
; - %V 在文件夹空白处 / 桌面空白处右键时展开为所在目录路径（Background
;   入口的标准参数；%1 在该场景不可靠）
; - 写 HKCU（当前用户）：无需管理员权限；安装器默认 per-user 安装，
;   per-machine 安装时菜单也只对执行安装的当前用户生效
; - exe 必须用模板变量 ${MAINBINARYNAME}（Cargo 二进制名，如
;   agentdev-claw-desktop.exe），不能写 productName——历史上硬编码
;   AgentDevClaw.exe 导致 command 指向不存在的文件、点击菜单无反应
; - command 整体用单引号包裹，内部 exe 路径与参数各自加双引号，
;   保证含空格的安装路径与目录路径正确传参
; - 菜单图标直接引用应用 exe 的内嵌图标（AgentDevClaw logo），无需
;   分发独立 ico 文件
; - 参数键名（--claw-open / --claw-new-chat）与 desktop/src/main.rs 的
;   parse_open_request、前端 modules/desktop-open.js 的 URL query 键
;   保持一致，三处同步修改

!macro NSIS_HOOK_PREINSTALL
  ; 覆盖升级只增不删：旧版遗留的指南文档（改名 / 删除后）会残留在
  ; app\guide 下，被指南目录树实时扫描成新旧混合的侧栏。安装前整目录
  ; 重建——guide 是纯分发资产，无用户数据（用户数据在 %USERPROFILE%\.agentdev）。
  RMDir /r "$INSTDIR\app\guide"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\AgentDevClaw.Open" "" "在编程小助手中打开"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\AgentDevClaw.Open" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\AgentDevClaw.Open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "--claw-open=%V"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\AgentDevClaw.NewChat" "" "在编程小助手中创建会话"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\AgentDevClaw.NewChat" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\AgentDevClaw.NewChat\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "--claw-new-chat=%V"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\AgentDevClaw.Open"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\AgentDevClaw.NewChat"
!macroend
