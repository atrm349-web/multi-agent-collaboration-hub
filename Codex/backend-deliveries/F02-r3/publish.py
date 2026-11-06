from pathlib import Path
import hashlib
import json
import shutil

workspace = Path(__file__).resolve().parents[2]
out = workspace / 'outputs/f02-r3'
shared = Path('./')
source = shared / 'apps/web/public'
manifest = json.loads((out / 'manifest.json').read_text())
before = json.loads((out / 'premerge-hashes.json').read_text())

def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()

for name, expected in before.items():
    assert digest(source / name) in (expected, manifest['sourceHashes'][name]), f'Concurrent change: {name}'
shutil.copyfile(out / 'source/app.js', source / 'app.js')
for name, expected in manifest['sourceHashes'].items():
    assert digest(source / name) == expected, f'Published hash mismatch: {name}'

lock_path = workspace / 'work/upstream/agetor/docs/hub/frontend-source-lock.json'
lock = json.loads(lock_path.read_text())
lock.update({key: manifest[key] for key in ('delivery', 'checkedAt', 'sourceHashes', 'nativeBundleHashes', 'reviewStatus')})
lock.update(manifestSha256=digest(out / 'manifest.json'), reviewFindings=[],
    note='F-02/I-01 accepted for verified macOS single-user MVP scope. R3 ambiguity rejected before mutation. Controlled browser evidence and prior real CLI success-path evidence remain separately classified.',
    sourceSnapshotNote='Merged latest Antigravity error handlers with Codex conservative compression guard; source hashes verified against desktop published files.',
    remainingLimits=['Ambiguous or terminal analysis requires replanning', 'Real-model forced failure/rework not verified this round', 'Windows/cross-vendor/long-run and running-process crash recovery pending'])
lock_text = json.dumps(lock, ensure_ascii=False, indent=2) + '\n'
lock_path.write_text(lock_text)
(out / 'frontend-source-lock.json').write_text(lock_text)
(shared / 'backend/agetor/docs/hub/frontend-source-lock.json').write_text(lock_text)

entry = '''\n\n## F02-r3 最新签收（2026-11-03，优先于此前 R3 暂缓记录）

Codex 已接管修复 R3-a/R3-b，合并 Antigravity 最新错误捕获。F-02/I-01 按 macOS 单用户 MVP 已验证范围签收。
9 项压缩测试/17断言、7 项桥接测试/36断言通过。IAB 实际验证分叉与末尾分析拒绝并保留预览，正常链式计划执行审批后 succeeded、DAG 3/3。
入口为 Codex/backend-deliveries/F02-r3/README.md。源码锁已同步到共享后端工作区，Git 提交状态未更新。
本轮 planner/provider/testRunner 受控，真实 CLI 成功路径沿用 B04-B06 证据。歧义分析节点需要重新拆解。真实模型失败返工、Windows/跨厂商及长时验收仍待完成。
'''
progress = shared / 'Codex/交接进度.md'
if '## F02-r3 最新签收' not in progress.read_text():
    with progress.open('a') as handle:
        handle.write(entry)
board = shared / 'docs/task-board.md'
lines = board.read_text().splitlines()
for i, line in enumerate(lines):
    if line.startswith('| F-02 |'):
        lines[i] = '| F-02 | Antigravity / Codex | macOS MVP 已验证范围签收 | F02-r3 修复 R3；9项压缩与7项桥接测试通过；歧义分析须重新拆解 |'
    if line.startswith('| I-01 |'):
        lines[i] = '| I-01 | Both | macOS MVP 已验证范围签收 | 受控浏览器3场景及最终审批成功；真实CLI成功路径见B04-B06；其余边界见F02-r3 |'
board.write_text('\n'.join(lines) + '\n')

hashes = {str(p.relative_to(out)): digest(p) for p in sorted(out.rglob('*')) if p.is_file() and p.name != 'SHA256.json'}
(out / 'SHA256.json').write_text(json.dumps(hashes, ensure_ascii=False, indent=2) + '\n')
delivery = shared / 'Codex/backend-deliveries/F02-r3'
shutil.copytree(out, delivery, dirs_exist_ok=True)
for name, expected in hashes.items():
    assert digest(delivery / name) == expected, f'Delivery mismatch: {name}'
print(f'Published and verified {len(hashes)} files at {delivery}')
