
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

    tell application "System Events" to tell process "Muse"
      set w to window 1
      set composer to my composerOf(w)
      set chat to my chatOf(w)
      set messages to UI elements of chat
      set outputText to my labelOf(composer)
      set countMessages to count of messages
      set startIndex to countMessages - 15
      if startIndex < 1 then set startIndex to 1
      repeat with i from startIndex to countMessages
        set messageElement to item i of messages
        set messageText to ""
        try
          if role of messageElement is "AXStaticText" then
            set messageText to my labelOf(messageElement)
          else
            repeat with childElement in entire contents of messageElement
              try
                if role of childElement is "AXStaticText" then
                  set t to my labelOf(childElement)
                  if t is not "" then set messageText to messageText & t & linefeed
                end if
              end try
            end repeat
          end if
        end try
        if messageText is not "" then set outputText to outputText & (character id 30) & messageText
      end repeat
      return outputText
    end tell
    