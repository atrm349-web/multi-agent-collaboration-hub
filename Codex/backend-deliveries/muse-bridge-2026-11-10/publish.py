from pathlib import Path
import hashlib
import json
import shutil

workspace = Path(__file__).resolve().parents[2]
work = workspace / 'work/closeout-2026-11-10'
out = Path(__file__).resolve().parent
shared = Path('/Users/anyunhong/Desktop/集合agent')
before = json.loads((out / 'before-hashes.json').read_text())

def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()

for name, expected in before.items():
    assert digest(shared / name) == expected, 'Concurrent source modification: ' + name
for name in before:
    for label, source in [('source-before', shared / name), ('source', work / name)]:
        target = out / label / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    target = shared / name
    temporary = target.with_name(target.name + '.codex-new')
    shutil.copy2(work / name, temporary)
    temporary.replace(target)
    assert digest(target) == digest(work / name)
manifest = {'delivery':'Codex muse-bridge-2026-11-10', 'activation':'hot update; next native Python invocation loads patched script',
            'fullNativeRoundTripVerified':False,
            'files':{name:{'beforeSha256':expected,'sha256':digest(shared/name)} for name,expected in before.items()}}
(out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
checks={str(p.relative_to(out)):digest(p) for p in out.rglob('*') if p.is_file() and p.name!='SHA256.json'}
(out/'SHA256.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2)+'\n')
delivery=shared/'Codex/backend-deliveries/muse-bridge-2026-11-10'
shutil.copytree(out,delivery,dirs_exist_ok=True)
assert all(digest(delivery/name)==expected for name,expected in checks.items())
print('Verified native bridge hot update and Desktop delivery:',len(checks),'files')
