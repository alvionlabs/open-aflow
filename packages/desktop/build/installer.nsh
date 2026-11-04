; Added to electron-builder's NSIS script through nsis.include.
;
; How the templates end a running app (electron-builder 26.18.1, allowOnlyOneInstallerInstance.nsh): PowerShell's
; Stop-Process by process ID, for each process whose exe sits in the install folder, or taskkill by image name when
; PowerShell is blocked. Neither takes /T, so a detached claude lives through it, and there's no override here.
; build-config.test.ts fails if a later version adds a tree kill. The uninstall proof shows it with a fake claude.

; Uninstall removes the login item. An uninstall that is part of an update or a reinstall passes --updated, and keeps it.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
  ${endIf}
!macroend
