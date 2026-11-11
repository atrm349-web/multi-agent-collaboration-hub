# 2026-11-10 终态任务取消按钮修复

截图中的任务已经因 MUSE_BRIDGE_ERROR / Could not find Muse composer 失败。前端取消按钮只排除了 succeeded/cancelled，遗漏 failed/timed_out，导致仍能提交取消请求，后端按终态保护返回 409 UNSUPPORTED_TRANSITION。

统一暂停、恢复、取消按钮与点击处理的状态判断。failed、timed_out、succeeded、cancelled、cancelling 禁用取消。请求处理中暂时禁用控制按钮并阻止重复提交，完成或失败后重新渲染，使用当前任务版本发送 CAS 请求。

前端回归 8 pass / 0 fail，47 条断言，覆盖各终态按钮、可取消状态、历史只读状态、待处理请求禁止重复提交。JavaScript 语法与真实前端集成构建通过。该修改涉及前端和对应测试，后端状态保护继续生效。

Muse/WorkBuddy 分工入口继续开放。截图中的 Muse 输入框定位错误需要单独检查原生桌面桥接，本修复覆盖取消按钮及重复提交。

同步文件和源码哈希见 manifest.json，实际服务加载见 deployment.json，源码锁已刷新。source-before 保留替换前文件。
