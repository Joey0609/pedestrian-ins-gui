; Expand the NSIS details panel by default so installation steps and file-copy
; progress are visible instead of being hidden behind the "Show details" link.
!macro customHeader
  ShowInstDetails show
  ShowUnInstDetails show
!macroend
