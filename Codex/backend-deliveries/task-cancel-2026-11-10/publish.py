from pathlib import Path
import datetime
import hashlib
import json
import os
import shutil
import signal
import sqlite3
import socket
import subprocess
import time
import urllib.parse
import urllib.request

workspace = Path(__file__).resolve().parents[2]
work = workspace / 'work/closeout-2026-11-10'
out = Path(__file__).resolve().parent
shared = Path('/Users/anyunhong/Desktop/集合agent')
before = json.loads((out / 'before-hashes.json').read_text())

def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()

changed = [name for name in before if digest(work / name) != before[name]]

# Validate every target before any shared source mutation.
for name in changed:
    target = shared / name
    if name in before:
        assert target.is_file() and digest(target) == before[name], 'Concurrent modification: ' + name
    else:
        assert not target.exists(), 'New target already exists: ' + name

runtime = Path.home() / '.agent-hub-runtime'
credentials_path = runtime / 'state/credentials.json'
credentials = json.loads(credentials_path.read_text()) if credentials_path.exists() else None
old_pid = None

def request(creds, path):
    req = urllib.request.Request(creds['origin'] + path, headers={'Authorization': 'Bearer ' + creds['token']})
    with urllib.request.urlopen(req, timeout=3) as response:
        value = json.loads(response.read())
        return value.get('data', value)

assert credentials and credentials.get('origin') == 'http://127.0.0.1:4321', 'Unexpected runtime credentials origin'
try:
    request(credentials, '/api/v1/meta')
    service_running = True
except OSError:
    service_running = False
if service_running:
    cursor = None
    while True:
        query = '/api/v1/tasks?limit=100' + ('&cursor=' + urllib.parse.quote(cursor) if cursor else '')
        page = request(credentials, query)
        assert all(task['status'] in ('succeeded', 'failed', 'cancelled', 'timed_out', 'waiting_approval', 'paused', 'draft') for task in page['items']), 'Active task prevents restart'
        cursor = page.get('nextCursor')
        if not cursor:
            break
    old_pid = int(credentials['pid'])
    command = subprocess.check_output(['/bin/ps', '-p', str(old_pid), '-o', 'command='], text=True)
    assert 'backend/agetor/scripts/start-hub.ts' in command, 'Unexpected process identity'
    cwd = subprocess.check_output(['/usr/sbin/lsof', '-a', '-p', str(old_pid), '-d', 'cwd', '-Fn'], text=True)
    assert 'n' + str(shared) in cwd, 'Unexpected service working directory'
else:
    # A stale credentials file is not authority to kill a reused PID.
    try:
        os.kill(int(credentials['pid']), 0)
    except ProcessLookupError:
        pass
    else:
        raise SystemExit('Recorded controller PID is alive but unreachable; no changes made')
    with socket.socket() as probe:
        assert probe.connect_ex(('127.0.0.1',4321)) != 0, 'Unexpected port listener'
    state_db = sqlite3.connect('file:' + str(runtime / 'state/agetor.sqlite') + '?mode=ro', uri=True)
    try:
        assert state_db.execute("SELECT COUNT(*) FROM hub_entities WHERE kind='run' AND status IN ('starting','running','cancelling')").fetchone()[0] == 0, 'Unfinished model execution'
        assert state_db.execute('SELECT COUNT(*) FROM hub_execution_slot').fetchone()[0] == 0, 'Unresolved execution slot'
        for (body,) in state_db.execute("SELECT data FROM hub_entities WHERE kind='task' AND status IN ('queued','running','decomposing','pausing','cancelling')"):
            task = json.loads(body)
            steps = [json.loads(row[0]) for row in state_db.execute("SELECT data FROM hub_entities WHERE kind='subtask' AND task_id=?", (task['id'],))]
            assert task['status'] == 'running' and any(step['status'] == 'blocked' and (step.get('error') or {}).get('code') == 'PROCESS_CRASHED' for step in steps), 'Unexpected unfinished task'
            assert all(step['status'] in ('blocked','pending','succeeded','failed','timed_out','cancelled') for step in steps), 'Task could dispatch work on startup'
    finally:
        state_db.close()

backup_dir = None
backup_dir = runtime / 'backups' / datetime.datetime.now().strftime('pre-hardening-%Y%m%d-%H%M%S')
backup_dir.mkdir(parents=True, mode=0o700)
for file in (runtime / 'state').iterdir():
    if file.suffix in ('.db', '.sqlite') and file.is_file():
        source_db = sqlite3.connect('file:' + str(file) + '?mode=ro', uri=True)
        backup_db = sqlite3.connect(str(backup_dir / file.name))
        source_db.backup(backup_db)
        backup_db.close()
        source_db.close()
        (backup_dir / file.name).chmod(0o600)
if old_pid:
    os.kill(old_pid, signal.SIGINT)
    deadline = time.time() + 15
    while time.time() < deadline:
        try:
            os.kill(old_pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.1)
    else:
        raise SystemExit('Old controller did not stop; source remains unchanged')

for name in changed:
    target = shared / name
    if target.exists():
        backup = out / 'source-before' / name
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(target, backup)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + '.codex-new')
    shutil.copy2(work / name, temporary)
    temporary.replace(target)
    copy = out / 'source' / name
    copy.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(work / name, copy)

manifest = {
    'delivery': 'Codex task-cancel-2026-11-10',
    'baseCommit': subprocess.check_output(['git', '-C', str(shared), 'rev-parse', 'HEAD'], text=True).strip(),
    'files': {name: {'sha256': digest(shared / name), 'beforeSha256': before.get(name)} for name in sorted(changed)},
}
(out / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
deployment = {'sourcePublished': True, 'changedFiles': len(changed), 'runtimeBackup': str(backup_dir) if backup_dir else None, 'serviceRestarted': False}

log_file = runtime / 'state/hardening-startup.log'
env = dict(os.environ)
env['HUB_RUNTIME_DIR'] = str(runtime)
env['PATH'] = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin:' + env.get('PATH', '')
with log_file.open('ab') as log:
    process = subprocess.Popen(['/Users/anyunhong/.bun/bin/bun', 'backend/agetor/scripts/start-hub.ts', 'config/hub-config.json'], cwd=shared, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
deadline = time.time() + 20
while time.time() < deadline:
    if process.poll() is not None:
        raise SystemExit('New controller exited; inspect private startup log ' + str(log_file))
    try:
        fresh = json.loads(credentials_path.read_text())
        if fresh.get('pid') != process.pid:
            time.sleep(0.2)
            continue
        meta = request(fresh, '/api/v1/meta')
        if 'needsAttention' in meta:
            req = urllib.request.Request(fresh['origin'] + '/app.js')
            with urllib.request.urlopen(req, timeout=3) as response:
                served_hash = hashlib.sha256(response.read()).hexdigest()
            expected = json.loads((out / 'frontend-source-lock.json').read_text())['nativeBundleHashes']['app.live-native.js']
            assert served_hash == expected, 'Served frontend differs from verified bridge'
            deployment.update(serviceStarted=True, serviceRestarted=bool(old_pid), previousServiceRunning=service_running, origin=fresh['origin'], pid=process.pid, needsAttention=meta['needsAttention'], servedAppHashMatches=True)
            break
    except (OSError, ValueError):
        pass
    time.sleep(0.2)
else:
    raise SystemExit('New controller did not become ready')

(out / 'deployment.json').write_text(json.dumps(deployment, ensure_ascii=False, indent=2) + '\n')
checks = {str(p.relative_to(out)): digest(p) for p in sorted(out.rglob('*')) if p.is_file() and p.name != 'SHA256.json' and 'node_modules' not in p.parts}
(out / 'SHA256.json').write_text(json.dumps(checks, ensure_ascii=False, indent=2) + '\n')
delivery = shared / 'Codex/backend-deliveries/task-cancel-2026-11-10'
shutil.copytree(out, delivery, dirs_exist_ok=True)
for name, expected in checks.items():
    assert digest(delivery / name) == expected, 'Delivery copy mismatch: ' + name
for name in changed:
    assert digest(shared / name) == manifest['files'][name]['sha256'], 'Published source mismatch: ' + name
print(json.dumps(deployment, ensure_ascii=False))
print('Verified delivery files', len(checks))
