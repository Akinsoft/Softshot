!define SOFTSHOT_VIDEO_PROGID "Softshot.Video"

!macro softshotRegisterOpenWith EXT
  WriteRegNone SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${SOFTSHOT_VIDEO_PROGID}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".${EXT}" ""
!macroend

!macro softshotUnregisterOpenWith EXT
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${SOFTSHOT_VIDEO_PROGID}"
!macroend

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SOFTSHOT_VIDEO_PROGID}" "" "Video"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SOFTSHOT_VIDEO_PROGID}" "FriendlyTypeName" "Video"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SOFTSHOT_VIDEO_PROGID}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SOFTSHOT_VIDEO_PROGID}\shell\open" "FriendlyAppName" "${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SOFTSHOT_VIDEO_PROGID}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  !insertmacro softshotRegisterOpenWith "mp4"
  !insertmacro softshotRegisterOpenWith "mov"
  !insertmacro softshotRegisterOpenWith "mkv"
  !insertmacro softshotRegisterOpenWith "webm"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  !insertmacro softshotUnregisterOpenWith "mp4"
  !insertmacro softshotUnregisterOpenWith "mov"
  !insertmacro softshotUnregisterOpenWith "mkv"
  !insertmacro softshotUnregisterOpenWith "webm"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${SOFTSHOT_VIDEO_PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
