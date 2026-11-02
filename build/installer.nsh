; Fills in the install location on Gamer's Settings > Apps entry (electron-builder leaves it blank).

!macro customInstall
  ; so Windows can match the program to its installed-apps entry
  WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"
!macroend
