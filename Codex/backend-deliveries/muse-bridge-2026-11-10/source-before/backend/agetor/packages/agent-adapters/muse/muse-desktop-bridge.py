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

cg = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
cg.CGEventCreateMouseEvent.restype = ctypes.c_void_p
cg.CGEventCreateMouseEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32, CGPoint, ctypes.c_uint32]
cg.CGEventCreateKeyboardEvent.restype = ctypes.c_void_p
cg.CGEventCreateKeyboardEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint16, ctypes.c_bool]
cg.CGEventSetFlags.argtypes = [ctypes.c_void_p, ctypes.c_uint64]
cg.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
cg.CFRelease.argtypes = [ctypes.c_void_p]

kCGEventFlagMaskCommand = 0x00100000

def ensure_muse_running():
    chk = subprocess.run(["pgrep", "-x", "Muse"], capture_output=True, text=True)
    if chk.returncode != 0:
        subprocess.run(["open", "-a", "/Applications/Muse.app"], check=True)
        time.sleep(3.5)
    subprocess.run(["open", "endo-window://hatch-full"], check=True)
    time.sleep(0.5)

def get_composer_info() -> Tuple[int, int, int, int, str]:
    script = """
    tell application "Muse" to activate
    delay 0.4
    tell application "System Events"
      tell process "Muse"
        set frontmost to true
        if (count of windows) is 0 then return "NO_WINDOW"
        set w to window 1
        try
          set webRoot to group 1 of UI element 1 of scroll area 1 of group 1 of group 1 of group 1 of group 1 of w
          repeat with e in UI elements of webRoot
            try
              set t to title of e as string
              if t contains "附加文件" then
                set {px, py} to position of e
                set {sw, sh} to size of e
                return (px as string) & "," & (py as string) & "," & (sw as string) & "," & (sh as string) & "|" & t
              end if
            end try
          end repeat
        on error errMsg
          return "ERR:" & errMsg
        end try
      end tell
    end tell
    return "NOT_FOUND"
    """
    last_err = ""
    for _ in range(8):
        res = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
        out = res.stdout.strip()
        if "|" in out:
            coords, title = out.split("|", 1)
            px, py, sw, sh = [int(x.strip()) for x in coords.split(",")]
            return px, py, sw, sh, title
        last_err = out
        time.sleep(0.5)
    raise RuntimeError(f"Could not find Muse composer: {last_err}")

def send_prompt_to_muse(prompt: str):
    ensure_muse_running()
    px, py, sw, sh, title = get_composer_info()
    cx, cy = float(px + 120), float(py + sh // 2)

    # 1. Click inside composer
    pt = CGPoint(cx, cy)
    d = cg.CGEventCreateMouseEvent(None, 1, pt, 0)
    u = cg.CGEventCreateMouseEvent(None, 2, pt, 0)
    cg.CGEventPost(0, d)
    time.sleep(0.05)
    cg.CGEventPost(0, u)
    cg.CFRelease(d)
    cg.CFRelease(u)
    time.sleep(0.2)

    # 2. Copy prompt to clipboard
    subprocess.run(["pbcopy"], input=prompt.encode("utf-8"), check=True)

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

    # 5. Click Send Button (bottom right corner)
    btn_pt = CGPoint(float(px + sw - 28), float(py + sh - 28))
    bd = cg.CGEventCreateMouseEvent(None, 1, btn_pt, 0)
    bu = cg.CGEventCreateMouseEvent(None, 2, btn_pt, 0)
    cg.CGEventPost(0, bd)
    time.sleep(0.05)
    cg.CGEventPost(0, bu)
    cg.CFRelease(bd)
    cg.CFRelease(bu)

def wait_for_muse_reply(timeout_sec: int = 180) -> str:
    start = time.time()
    saw_stop = False

    while time.time() - start < timeout_sec:
        time.sleep(1.0)
        chk_script = """
        tell application "System Events" to tell process "Muse"
          set webRoot to group 1 of UI element 1 of scroll area 1 of group 1 of group 1 of group 1 of group 1 of window 1
          repeat with e in UI elements of webRoot
            try
              set t to title of e as string
              if t contains "附加文件" then return t
            end try
          end repeat
        end tell
        """
        btn = subprocess.run(["osascript", "-e", chk_script], capture_output=True, text=True).stdout.strip()
        if "停止" in btn:
            saw_stop = True
        elif saw_stop and ("发送" in btn or "停止" not in btn):
            time.sleep(2.0)
            break

    # Read the latest assistant reply from chatMsgs
    read_script = """
    tell application "System Events" to tell process "Muse"
      set webRoot to group 1 of UI element 1 of scroll area 1 of group 1 of group 1 of group 1 of group 1 of window 1
      set g3 to group 3 of webRoot
      set chatMsgs to group "聊天消息" of g3
      set c to count of UI elements of chatMsgs
      set out to {}
      set startIdx to (c - 8)
      if startIdx < 1 then set startIdx to 1
      repeat with i from startIdx to c
        try
          set m to UI element i of chatMsgs
          set subElems to entire contents of m
          set mText to ""
          repeat with s in subElems
            try
              if role of s is "AXStaticText" then
                set v to value of s as string
                if v is not "missing value" and length of v > 0 then
                  set mText to mText & "\n" & v
                end if
              end if
            end try
          end repeat
          if length of mText > 0 then
            set end of out to (i as string) & "|||" & mText
          end if
        end try
      end repeat
      return out
    end tell
    """
    res = subprocess.run(["osascript", "-e", read_script], capture_output=True, text=True)
    raw = res.stdout.strip()

    blocks = raw.split(", ")
    candidate_replies = []
    for b in blocks:
        if "|||" in b:
            _, text = b.split("|||", 1)
            clean = text.strip()
            if clean.startswith("你：") or "Task goal (untrusted data):" in clean:
                continue
            if len(clean) > 0:
                candidate_replies.append(clean)

    if candidate_replies:
        return max(candidate_replies, key=len)

    return ""

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
        send_prompt_to_muse(task_prompt)
        reply = wait_for_muse_reply(timeout_sec=timeout)

        artifacts = []
        if os.path.isdir(workspace):
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
