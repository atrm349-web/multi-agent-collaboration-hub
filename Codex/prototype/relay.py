"""C-04/C-05: bounded, real Codex CLI relay; no third-party dependencies."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import time
import uuid


class RunFailure(RuntimeError):
    pass


def classify(returncode, events):
    if returncode != 0:
        return "PROCESS_FAILED"
    if any(e.get("type") == "turn.failed" for e in events):
        return "TURN_FAILED"
    if not any(e.get("type") == "turn.completed" for e in events):
        return "MISSING_TERMINAL_EVENT"
    return None


def terminate(proc):
    if proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait(timeout=3)


def run_codex(root, db, role, prompt, timeout=90, session=None):
    run_id = str(uuid.uuid4())
    folder = root / run_id
    folder.mkdir(mode=0o700)
    args = ["codex", "exec", "--ignore-user-config", "--sandbox", "read-only",
            "--json", "--color", "never", "--skip-git-repo-check",
            "-c", "features.apps=false", "-C", str(root / "workspace")]
    if session:
        args += ["resume", session]
    args += ["-"]
    db.execute("INSERT INTO runs VALUES (?,?,?,?,?,?,?)",
               (run_id, role, "running", session, None, time.time(), None))
    db.commit()
    # Credentials stay in the CLI's existing auth store; API-key env is not inherited.
    env = {k: v for k, v in os.environ.items()
           if not any(s in k.upper() for s in ("TOKEN", "SECRET", "PASSWORD", "API_KEY"))}
    proc = None
    error = None
    events = []
    try:
        with (folder / "events.jsonl").open("w") as out, (folder / "stderr.log").open("w") as err:
            proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=out, stderr=err,
                                    env=env, start_new_session=True, text=True)
            try:
                proc.communicate(prompt, timeout=timeout)
            except subprocess.TimeoutExpired:
                error = "TIMEOUT"
                terminate(proc)
            except KeyboardInterrupt:
                error = "CANCELLED"
                terminate(proc)
        for line in (folder / "events.jsonl").read_text().splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict):
                events.append(event)
        error = error or classify(proc.returncode, events)
        session = next((e["thread_id"] for e in events
                        if e.get("type") == "thread.started"), session)
        messages = [e["item"]["text"] for e in events
                    if e.get("type") == "item.completed"
                    and e.get("item", {}).get("type") == "agent_message"]
        if not error and not messages:
            error = "MISSING_RESULT"
        state = "cancelled" if error == "CANCELLED" else "failed" if error else "succeeded"
        db.execute("UPDATE runs SET state=?,session_id=?,error=?,ended_at=? WHERE id=?",
                   (state, session, error, time.time(), run_id))
        db.commit()
        if error:
            raise RunFailure(f"{error}: {folder}")
        result = messages[-1]
        (folder / "result.txt").write_text(result)
        return session, result, run_id
    except (OSError, RunFailure):
        if proc:
            terminate(proc)
        db.execute("UPDATE runs SET state='failed',error=COALESCE(error,'SPAWN_ERROR'),ended_at=? "
                   "WHERE id=? AND state='running'", (time.time(), run_id))
        db.commit()
        raise


CHECK = """from clamp import clamp
assert clamp(-1, 0, 10) == 0
assert clamp(5, 0, 10) == 5
assert clamp(11, 0, 10) == 10
assert clamp(10, 0, 10) == 10
try:
    clamp(1, 10, 0)
except ValueError:
    pass
else:
    raise AssertionError('reversed bounds must raise ValueError')
print('5 acceptance cases passed')
"""


def validate_code(workspace, code):
    # This proof accepts one fixed, reviewed Python function; not a general code sandbox.
    import ast
    tree = ast.parse(code)
    if len(tree.body) != 1 or not isinstance(tree.body[0], ast.FunctionDef):
        raise RunFailure("INVALID_ARTIFACT: expected one function")
    allowed = (ast.Module, ast.FunctionDef, ast.arguments, ast.arg, ast.If, ast.Compare,
               ast.Gt, ast.Lt, ast.GtE, ast.LtE, ast.Return, ast.Name, ast.Load,
               ast.Call, ast.Raise, ast.Constant)
    if any(not isinstance(n, allowed) for n in ast.walk(tree)):
        raise RunFailure("INVALID_ARTIFACT: expression not allowed by proof")
    if any(isinstance(n, ast.Call) and
           (not isinstance(n.func, ast.Name) or n.func.id not in {"min", "max", "ValueError"})
           for n in ast.walk(tree)):
        raise RunFailure("INVALID_ARTIFACT: call not allowed")
    if tree.body[0].name != "clamp" or tree.body[0].decorator_list:
        raise RunFailure("INVALID_ARTIFACT: expected clamp")
    (workspace / "clamp.py").write_text(code)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False, mode=0o700)
    workspace = root / "workspace"
    workspace.mkdir()
    db = sqlite3.connect(root / "state.sqlite")
    db.executescript("""CREATE TABLE runs(id TEXT PRIMARY KEY,role TEXT,state TEXT,
        session_id TEXT,error TEXT,started_at REAL,ended_at REAL);
        CREATE TABLE messages(id TEXT PRIMARY KEY,from_run TEXT,to_role TEXT,payload TEXT);
        CREATE TABLE artifacts(path TEXT,sha256 TEXT,producer_run TEXT);
    """)
    developer = """Do not use tools. Return ONLY JSON with a single string key code.
Write def clamp(value, low, high) using only if, comparison, raise ValueError,
return, min/max, names and literals. If low > high raise ValueError; otherwise
return value bounded inclusively by low and high. No imports, annotations,
docstrings, decorators, markdown, assignments or extra definitions."""
    a_session, text, a_run = run_codex(root, db, "developer", developer)
    code = json.loads(text)["code"]
    validate_code(workspace, code)
    (workspace / "acceptance.py").write_text(CHECK)
    # Intentional fault injection is recorded separately from the actual Agent A output.
    original_hash = hashlib.sha256(code.encode()).hexdigest()
    (workspace / "clamp.py").write_text("def clamp(value, low, high):\n    return max(low, min(value, high))\n")
    check = subprocess.run([sys.executable, "-I", "-B", "-c",
                            "import runpy,sys;sys.path.insert(0,'.');runpy.run_path('acceptance.py')"],
                           cwd=workspace, capture_output=True, text=True, timeout=10)
    assert check.returncode != 0, "fault injection did not trigger acceptance failure"
    handoff = {"artifact": "clamp.py", "originalSha256": original_hash,
               "faultInjected": True, "testExitCode": check.returncode,
               "testOutput": check.stderr, "code": (workspace / "clamp.py").read_text()}
    db.execute("INSERT INTO messages VALUES (?,?,?,?)",
               (str(uuid.uuid4()), a_run, "reviewer", json.dumps(handoff)))
    db.commit()
    b_session, review, b_run = run_codex(root, db, "reviewer",
        "Independent review. Do not use tools. Given this artifact and ACTUAL trusted test output, "
        "return ONLY JSON with keys approved (boolean), reason (string). "
        "Reversed bounds must raise ValueError.\n" + json.dumps(handoff))
    decision = json.loads(review)
    if decision.get("approved") is not False:
        raise RunFailure("REVIEW_FAILED_TO_DETECT_INJECTED_FAULT")
    db.execute("INSERT INTO messages VALUES (?,?,?,?)",
               (str(uuid.uuid4()), b_run, "developer", review))
    db.commit()
    _, fixed, fixed_run = run_codex(root, db, "developer-repair",
        developer + "\nReviewer feedback: " + review, session=a_session)
    validate_code(workspace, json.loads(fixed)["code"])
    final = subprocess.run([sys.executable, "-I", "-B", "-c",
                            "import runpy,sys;sys.path.insert(0,'.');runpy.run_path('acceptance.py')"],
                           cwd=workspace, capture_output=True, text=True, timeout=10)
    if final.returncode:
        raise RunFailure("ACCEPTANCE_FAILED: repair budget exhausted")
    _, _, verification_run = run_codex(root, db, "reviewer-verification",
        "The developer repaired clamp.py. Now independently execute the existing acceptance.py "
        "using your shell tool in the current workspace. Use python3 -I -B -c "
        "\"import runpy,sys;sys.path.insert(0,'.');runpy.run_path('acceptance.py')\". "
        "Do not edit any files. Report actual test outcome.", session=b_session)
    verification_events = [json.loads(line) for line in
                           (root / verification_run / "events.jsonl").read_text().splitlines()]
    reviewer_ran_tests = any(e.get("type") == "item.completed"
        and e.get("item", {}).get("type") == "command_execution"
        and e["item"].get("exit_code") == 0
        and "5 acceptance cases passed" in e["item"].get("aggregated_output", "")
        and "acceptance.py" in e["item"].get("command", "") for e in verification_events)
    (root / "acceptance.json").write_text(json.dumps({
        "execution": "real", "faultInjected": True, "initialTestExit": check.returncode,
        "finalTestExit": final.returncode, "stdout": final.stdout, "stderr": final.stderr,
        "developerSession": a_session, "reviewerSession": b_session,
        "independentSessions": a_session != b_session,
        "reviewerRanTests": reviewer_ran_tests, "testsExecutedBy": "coordinator-and-reviewer",
        "repairUsedResume": True}, indent=2))
    if not reviewer_ran_tests:
        raise RunFailure("REVIEWER_TEST_EXECUTION_UNVERIFIED")
    db.execute("INSERT INTO artifacts VALUES (?,?,?)", ("workspace/clamp.py",
               hashlib.sha256((workspace / "clamp.py").read_bytes()).hexdigest(), fixed_run))
    db.commit()
    print(f"REAL_RELAY_PASSED: {root}")


if __name__ == "__main__":
    main()
