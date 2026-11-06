# B-01 安全参数改造 — 已完成本轮验收

日期：2026-11-02；分支 codex/b01-b02-safe-runtime。
上游基准：5ebf2aa4d634d53a071b0a44c0f378664e498ba4。

已完成：
- 移除Codex遇到外部Git元数据时自动danger-full-access的逻辑；auto遇到该需求现在明确PERMISSION_DENIED，read-only审核仍允许。
- 拒绝非空AGETOR_CODEX_ARGS，防止额外flags覆盖沙箱；拒绝不支持的mode和歧义resume参数。
- 固定忽略用户执行配置、禁止审批提权、清空额外写根、关闭终端网络，并排除/tmp和TMPDIR的默认额外写权限。
- CLI发现默认不再自动启用；操作系统级受信配置AGETOR_HARNESS_AUTO_ENABLE=1仍可显式选择旧机制，受控Hub入口不提供此开关。

验证：agents/worktree/harness-auto-enable共413测试通过、0失败。tests.log是实际Bun测试日志。source包含五份修改文件，changes.patch可供审核，尚未提交远程。

边界：这不是原版Agetor全部harness的安全认证；原产品其他执行器保留历史兼容。B-02受控Hub入口只允许Codex，真实目录校验和进程生命周期验证仍在进行。尚未接入旧版桌面会话，不接管不明权限进程；尚未宣称完整文件读取隔离。

Antigravity可现在读取本包了解安全行为；请勿把旧Mock改成live或启动原Agetor的其他CLI。前端继续F-03 v0.2迁移，真实API联调等待B-03及后续完成。
