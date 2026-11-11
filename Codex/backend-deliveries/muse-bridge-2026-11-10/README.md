# Muse 桌面输入框定位修复

2026-11-10 根据用户运行失败修复原生桥接。现场 CUA 已确认 Muse 当前窗口结构为 window → container → scroll area → HTML content → container，输入区域暴露为带有“消息 附加文件 语音输入一条消息 发送”标签的复合按钮。旧脚本固定索引 group 1 of UI element 1 of scroll area 1 of group 1 …，无法适应当前层级。

已改为按控件角色、语义标签及尺寸寻找输入区域，在回复读取中按“聊天消息”区域查找，支持中英文标签。保留当前坐标系中的输入与发送操作。AppleScript 调用设置超时并保留辅助功能/自动化拒绝的诊断。

同时修复回复关联链路。发送前记录消息基线，仅接收后续新回复，过滤用户回显，保持逗号和多行内容，支持未观测到停止按钮的快速回复。超时明确失败，避免读取旧长回复并错误标记成功。

验证包括 6 项 Python 隔离回归通过、Python 语法检查通过、两份 AppleScript 使用系统 osacompile 编译通过。测试替换 subprocess 和时钟，未执行桌面桥接操作。CUA 已观察实际 Muse 控件结构，期间出现一次原生窗口临时不可用，重新选择后可读取。修补后的 Hub→Python→Muse→交付完整实机闭环待复测。

本次热更新 Python 桥接文件。后续 Muse 调用创建的新 Python 子进程会加载修复，无需重启 Hub。源码锁记录桥接 SHA-256，替换前源码保存在 source-before。Muse/WorkBuddy 分工开放保持当前设置。

测试可在本交付目录执行 PYTHONDONTWRITEBYTECODE=1 python3 test_bridge.py，它默认读取本目录 source 中的修复快照，也可通过 MUSE_BRIDGE_SOURCE 指定当前源文件。发布与哈希核验见 manifest.json 和 SHA256.json。
