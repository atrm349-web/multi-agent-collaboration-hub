#!/usr/bin/env python3
"""
Real macOS Meta Muse Desktop Bridge for Multi-Agent Collaboration Hub.
Directly automates /Applications/Muse.app via native macOS Accessibility and CoreGraphics.
Zero mock data: all executions use the real Meta Muse app and its user quota.
"""

import sys
import json
import time
import os
import re
import subprocess
import ctypes
from typing import Dict, Any, Optional, Tuple, List

class CGPoint(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]

def core_graphics():
    cg = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
    cg.CGEventCreateMouseEvent.restype = ctypes.c_void_p
    cg.CGEventCreateMouseEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32, CGPoint, ctypes.c_uint32]
    cg.CGEventCreateKeyboardEvent.restype = ctypes.c_void_p
    cg.CGEventCreateKeyboardEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint16, ctypes.c_bool]
    cg.CGEventSetFlags.argtypes = [ctypes.c_void_p, ctypes.c_uint64]
    cg.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
    cg.CGWarpMouseCursorPosition.argtypes = [CGPoint]
    cg.CFRelease.argtypes = [ctypes.c_void_p]
    return cg

kCGEventFlagMaskCommand = 0x00100000

def ensure_muse_running():
    chk = subprocess.run(["pgrep", "-x", "Muse"], capture_output=True, text=True)
    if chk.returncode != 0:
        subprocess.run(["open", "-a", "/Applications/Muse.app"], check=True)
        time.sleep(3.5)
    subprocess.run(["open", "endo-window://hatch-full"], check=True)
    time.sleep(0.6)

# Semantic AX lookup selecting the main Hatch window (ignoring the 187x61 floating mini-pill)
# and scanning `entire contents of w` efficiently from the bottom up.
AX_HELPERS = r"""
on labelOf(e)
  tell application "System Events"
    try
      set t to title of e
      if t is not missing value and (t as text) is not "" then return t as text
    end try
    try
      set d to description of e
      if d is not missing value and (d as text) is not "" then return d as text
    end try
    try
      set v to value of e
      if v is not missing value and (v as text) is not "" then return v as text
    end try
  end tell
  return ""
end labelOf

on mainWindowOf()
  tell application "System Events" to tell process "Muse"
    if (count of windows) is 0 then error "MUSE_NO_WINDOW"
    repeat with w in windows
      try
        set {sw, sh} to size of w
        if sw > 400 and sh > 400 then return contents of w
      end try
    end repeat
    return window 1
  end tell
end mainWindowOf

on composerOf(w)
  tell application "System Events"
    set allElems to entire contents of w
    repeat with idx from (count of allElems) to 1 by -1
      try
        set e to item idx of allElems
        if role of e is "AXButton" then
          set t to ""
          try
            set t to title of e
          end try
          if t is not missing value and (t as text) is not "" then
            set labelText to t as text
          else
            set labelText to my labelOf(e)
          end if
          if labelText contains "附加文件" or labelText contains "Attach files" or labelText contains "停止" or labelText contains "Stop" or labelText contains "发送" or labelText contains "Send" then
            set {sw, sh} to size of e
            if sw > 160 and sh > 25 then return contents of e
          end if
        end if
      end try
    end repeat
  end tell
  error "MUSE_COMPOSER_NOT_FOUND: no visible message composer"
end composerOf
"""


def run_ax_script(script: str) -> str:
    result = subprocess.run(["osascript", "-e", AX_HELPERS + script],
                            capture_output=True, text=True, timeout=15)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(f"MUSE_ACCESSIBILITY_ERROR: {detail}")
    return result.stdout.strip()


def get_composer_info() -> Tuple[int, int, int, int, str]:
    script = r"""
    tell application "Muse" to activate
    delay 0.25
    tell application "System Events" to tell process "Muse"
      set frontmost to true
      set w to my mainWindowOf()
      set e to my composerOf(w)
      set {px, py} to position of e
      set {sw, sh} to size of e
      return (px as text) & "," & (py as text) & "," & (sw as text) & "," & (sh as text) & "|" & my labelOf(e)
    end tell
    """
    last_error = ""
    for attempt in range(8):
        try:
            raw = run_ax_script(script)
            coords, title = raw.split("|", 1)
            px, py, sw, sh = [int(float(value.strip())) for value in coords.split(",")]
            if sw <= 160 or sh <= 25:
                raise ValueError("invalid composer dimensions")
            return px, py, sw, sh, title
        except (RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
            last_error = str(error)
            if "not authorized" in last_error.lower() or "-1743" in last_error or "-1719" in last_error or "-25211" in last_error:
                break
            if attempt < 7:
                time.sleep(0.5)
    raise RuntimeError(f"Could not find Muse composer: {last_error}")


def read_chat_snapshot() -> Tuple[str, List[str]]:
    raw = run_ax_script(r"""
    tell application "System Events" to tell process "Muse"
      set w to my mainWindowOf()
      set composerLabel to ""
      set allElems to entire contents of w
      set totalCount to count of allElems
      set startIndex to totalCount - 50
      if startIndex < 1 then set startIndex to 1
      repeat with i from startIndex to totalCount
        set e to item i of allElems
        try
          if role of e as text is "AXButton" then
            set t to ""
            try
              set t to title of e as text
            on error
              set t to my labelOf(e)
            end try
            if t contains "附加文件" or t contains "Attach files" or t contains "停止" or t contains "Stop" or t contains "发送" or t contains "Send" then
              set composerLabel to t
            end if
          end if
        end try
      end repeat
      if composerLabel is "" then
        try
          set composer to my composerOf(w)
          set composerLabel to my labelOf(composer)
        end try
      end if

      set bodyText to ""
      try
        set gRoot to group 1 of UI element 1 of scroll area 1 of group 1 of group 1 of group 1 of group 1 of w
        set chatGroup to group "聊天消息" of group 3 of gRoot
        set elemCount to count of UI elements of chatGroup
        set startIdx to elemCount - 6
        if startIdx < 1 then set startIdx to 1
        repeat with idx from startIdx to elemCount
          set el to UI element idx of chatGroup
          try
            set ec to entire contents of el
            repeat with itm in ec
              try
                if role of itm as text is "AXStaticText" then
                  set v to value of itm as text
                  if v is not "missing value" and v is not "" then
                    set bodyText to bodyText & (character id 30) & v
                  end if
                end if
              end try
            end repeat
          end try
        end repeat
      on error
        repeat with i from startIndex to totalCount
          set e to item i of allElems
          try
            if role of e as text is "AXStaticText" then
              set v to value of e as text
              if v is not "missing value" and v is not "" then
                set bodyText to bodyText & (character id 30) & v
              end if
            end if
          end try
        end repeat
      end try

      return composerLabel & bodyText
    end tell
    """)
    parts = raw.split("\x1e")
    return parts[0], [part.strip() for part in parts[1:] if part.strip()]


def new_reply(messages: List[str], baseline: List[str], prompt: str) -> str:
    prompt_clean = prompt.strip()
    prompt_first_line = prompt_clean.splitlines()[0].strip() if prompt_clean else ""

    prompt_pos = None
    for i, m in enumerate(messages):
        if prompt_clean in m or (prompt_first_line and len(prompt_first_line) > 12 and prompt_first_line[:20] in m):
            prompt_pos = i

    if prompt_pos is not None:
        messages = messages[prompt_pos + 1:]
    elif baseline:
        found_pos = None
        for b_msg in reversed(baseline):
            positions = [i for i, text in enumerate(messages) if text == b_msg]
            if positions:
                found_pos = positions[-1]
                break
        if found_pos is not None:
            messages = messages[found_pos + 1:]
        else:
            return ""

    output = []
    for text in messages:
        clean = text.strip()
        if not clean:
            continue
        if clean.startswith(("用户消息", "你：", "You:", "Task goal (untrusted data):")) or clean == prompt_clean:
            continue
        if prompt_first_line and len(prompt_first_line) > 12 and clean.startswith(prompt_first_line):
            continue
        if "[Meta Muse" in clean and ("自带额度说明" in clean or "额度说明" in clean):
            continue
        if re.fullmatch(r"(?:(?:\d{1,2}月\d{1,2}日|今天|昨天)\s*)?\d{1,2}:\d{2}", clean):
            continue
        if clean in ("复制回复", "回复", "分享", "重新生成", "赞", "踩", "停止", "发送", "附加文件"):
            continue
        clean = re.sub(r"^(?:助手消息[:：]|Assistant:)\s*", "", clean)
        if clean:
            output.append(clean)
    return "\n\n".join(output)


def send_prompt_to_muse(prompt: str):
    cg = core_graphics()
    ensure_muse_running()
    subprocess.run(["osascript", "-e", 'tell application "Muse" to activate\ntell application "System Events" to tell process "Muse" to set frontmost to true'],
                   capture_output=True, text=True)
    time.sleep(0.3)

    px, py, sw, sh, title = get_composer_info()
    if "停止" in title or "Stop" in title:
        raise RuntimeError("AGENT_UNAVAILABLE: Muse is already generating a response")
    _, baseline = read_chat_snapshot()
    cx, cy = float(px + min(120, sw // 3)), float(py + sh // 2)

    # 1. Click inside composer
    pt = CGPoint(cx, cy)
    cg.CGWarpMouseCursorPosition(pt)
    d = cg.CGEventCreateMouseEvent(None, 1, pt, 0)
    u = cg.CGEventCreateMouseEvent(None, 2, pt, 0)
    cg.CGEventPost(0, d)
    time.sleep(0.05)
    cg.CGEventPost(0, u)
    cg.CFRelease(d)
    cg.CFRelease(u)
    time.sleep(0.2)

    # 2. Copy prompt to clipboard with UTF-8 env
    env = dict(os.environ, LANG="en_US.UTF-8", LC_ALL="en_US.UTF-8")
    subprocess.run(["pbcopy"], input=prompt.encode("utf-8"), env=env, check=True)

    # 3. Cmd+A
    ev_a_down = cg.CGEventCreateKeyboardEvent(None, 0, True)
    cg.CGEventSetFlags(ev_a_down, kCGEventFlagMaskCommand)
    ev_a_up = cg.CGEventCreateKeyboardEvent(None, 0, False)
    cg.CGEventSetFlags(ev_a_up, kCGEventFlagMaskCommand)
    cg.CGEventPost(0, ev_a_down)
    time.sleep(0.05)
    cg.CGEventPost(0, ev_a_up)
    cg.CFRelease(ev_a_down)
    cg.CFRelease(ev_a_up)
    time.sleep(0.1)

    # 4. Cmd+V
    ev_v_down = cg.CGEventCreateKeyboardEvent(None, 9, True)
    cg.CGEventSetFlags(ev_v_down, kCGEventFlagMaskCommand)
    ev_v_up = cg.CGEventCreateKeyboardEvent(None, 9, False)
    cg.CGEventSetFlags(ev_v_up, kCGEventFlagMaskCommand)
    cg.CGEventPost(0, ev_v_down)
    time.sleep(0.05)
    cg.CGEventPost(0, ev_v_up)
    cg.CFRelease(ev_v_down)
    cg.CFRelease(ev_v_up)
    time.sleep(0.3)

    # 5. Press Return (key code 36) to submit message
    ret_down = cg.CGEventCreateKeyboardEvent(None, 36, True)
    ret_up = cg.CGEventCreateKeyboardEvent(None, 36, False)
    cg.CGEventPost(0, ret_down)
    time.sleep(0.05)
    cg.CGEventPost(0, ret_up)
    cg.CFRelease(ret_down)
    cg.CFRelease(ret_up)
    time.sleep(0.2)

    return baseline

def wait_for_muse_reply(timeout_sec: int = 180, baseline: Optional[List[str]] = None, prompt: str = "") -> str:
    deadline = time.monotonic() + timeout_sec
    stable_since = None
    last_reply = ""
    while time.monotonic() < deadline:
        try:
            title, messages = read_chat_snapshot()
        except Exception:
            time.sleep(0.5)
            continue
        reply = new_reply(messages, baseline or [], prompt)
        generating = "停止" in title or "Stop" in title
        if reply and not generating:
            if reply != last_reply:
                last_reply = reply
                stable_since = time.monotonic()
            elif stable_since is not None and time.monotonic() - stable_since >= 2:
                return reply
        else:
            last_reply = ""
            stable_since = None
        time.sleep(0.5)
    raise RuntimeError("TIMEOUT: Muse did not produce a new completed reply before the deadline")


def extract_code_blocks(text: str) -> Dict[str, str]:
    files = {}
    pattern = r"```(?:([a-zA-Z0-9_\-]+)\s*\n)?(?:#\s*file:\s*([^\n]+)\n|//\s*file:\s*([^\n]+)\n)?([\s\S]*?)```"
    matches = re.findall(pattern, text)
    for lang, f1, f2, code in matches:
        filename = f1.strip() if f1 else (f2.strip() if f2 else None)
        if filename:
            files[filename] = code.strip()
    return files

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: muse-desktop-bridge.py <run_spec.json>"}))
        sys.exit(1)

    spec_arg = sys.argv[1]
    if os.path.exists(spec_arg):
        with open(spec_arg, "r", encoding="utf-8") as f:
            spec = json.load(f)
    else:
        spec = json.loads(spec_arg)

    task_prompt = spec.get("task", "")
    workspace = spec.get("workspace", os.getcwd())
    output_mode = spec.get("output", "text")
    timeout = int(spec.get("timeoutSeconds", 180))

    try:
        baseline = send_prompt_to_muse(task_prompt)
        reply = wait_for_muse_reply(timeout_sec=timeout, baseline=baseline, prompt=task_prompt)

        artifacts = []
        # Only write DELIVERY_REPORT.md and code blocks in non-JSON (developer/documentation) mode,
        # so read-only JSON review/planning runs never overwrite workspace files!
        if output_mode != "json" and os.path.isdir(workspace) and os.access(workspace, os.W_OK):
            report_path = os.path.join(workspace, "DELIVERY_REPORT.md")
            with open(report_path, "w", encoding="utf-8") as f:
                f.write(f"# Meta Muse 成果交付报告\n\n**模型**: Meta Muse (Spark 1.3 桌面端真实执行)\n**执行时间**: {time.strftime('%Y-%m-%d %H:%M:%S')}\n\n---\n\n{reply}\n")
            artifacts.append({
                "path": "DELIVERY_REPORT.md",
                "name": "DELIVERY_REPORT.md",
                "bytes": os.path.getsize(report_path)
            })

            extracted = extract_code_blocks(reply)
            for fname, fcontent in extracted.items():
                safe_fname = os.path.basename(fname)
                fpath = os.path.join(workspace, safe_fname)
                with open(fpath, "w", encoding="utf-8") as f:
                    f.write(fcontent + "\n")
                artifacts.append({
                    "path": safe_fname,
                    "name": safe_fname,
                    "bytes": os.path.getsize(fpath)
                })

        parsed_json = None
        if output_mode == "json":
            json_match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", reply)
            raw_json = json_match.group(1).strip() if json_match else reply.strip()
            try:
                parsed_json = json.loads(raw_json)
            except Exception:
                start_idx = raw_json.find("{")
                end_idx = raw_json.rfind("}")
                if start_idx != -1 and end_idx != -1 and end_idx > start_idx:
                    try:
                        parsed_json = json.loads(raw_json[start_idx:end_idx+1])
                    except Exception:
                        pass

        output = {
            "status": "completed",
            "reply": reply,
            "json": parsed_json,
            "artifacts": artifacts,
            "quotaType": "self_quota",
            "model": "Muse Spark 1.3 (Desktop Native)"
        }
        print(json.dumps(output, ensure_ascii=False))

    except Exception as e:
        err_out = {
            "status": "failed",
            "error": str(e)
        }
        print(json.dumps(err_out, ensure_ascii=False))
        sys.exit(1)

if __name__ == "__main__":
    main()
