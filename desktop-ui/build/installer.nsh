; Register working-memory:// links at install time so they open before first launch.
; Data-tier instances are managed inside the app (environment menu > Manage instances).
!macro customInstall
  WriteRegStr HKCU "Software\Classes\working-memory" "" "URL:Working Memory"
  WriteRegStr HKCU "Software\Classes\working-memory" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\working-memory\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /End /TN "Working Memory Embeddings"'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /Delete /TN "Working Memory Embeddings" /F'
  Pop $0
  DeleteRegKey HKCU "Software\Classes\working-memory"
!macroend
