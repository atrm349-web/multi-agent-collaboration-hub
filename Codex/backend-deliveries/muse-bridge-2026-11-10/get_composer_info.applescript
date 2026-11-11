
on labelOf(e)
  tell application "System Events"
    repeat with fieldName in {"AXTitle", "AXDescription", "AXValue"}
      try
        set v to value of attribute (contents of fieldName) of e
        if v is not missing value and (v as text) is not "" then return v as text
      end try
    end repeat
  end tell
  return ""
end labelOf

on composerOf(w)
  tell application "System Events"
    repeat with e in entire contents of w
      try
        set labelText to my labelOf(e)
        if role of e is "AXButton" and (labelText contains "附加文件" or labelText contains "Attach files") then
          set {sw, sh} to size of e
          if sw > 160 and sh > 25 then return contents of e
        end if
      end try
    end repeat
  end tell
  error "MUSE_COMPOSER_NOT_FOUND: no visible message composer"
end composerOf

on chatOf(w)
  tell application "System Events"
    repeat with e in entire contents of w
      try
        set labelText to my labelOf(e)
        if role of e is "AXGroup" and (labelText is "聊天消息" or labelText is "Chat messages") then return contents of e
      end try
    end repeat
  end tell
  error "MUSE_CHAT_NOT_FOUND: no chat message group"
end chatOf

    tell application "Muse" to activate
    tell application "System Events" to tell process "Muse"
      set frontmost to true
      if (count of windows) is 0 then error "MUSE_NO_WINDOW"
      set e to my composerOf(window 1)
      set {px, py} to position of e
      set {sw, sh} to size of e
      return (px as text) & "," & (py as text) & "," & (sw as text) & "," & (sh as text) & "|" & my labelOf(e)
    end tell
    