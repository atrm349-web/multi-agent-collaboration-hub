# F-02 / I-01 最终交叉复核与源码哈希同步

日期：2026-11-03。复核方：Codex。复核基线：后端9322bac26700a251947469a379658607cff4bb4b。

**结论：源码哈希同步通过；真实控制器/HTTP/Chrome受控交互复跑通过；F-02/I-01最终签收暂不通过，需要修复下列问题。** 未覆盖或有反证的检查不计为通过。本报告不覆盖、改写Antigravity原始报告及前端源码。

## 已确认

- 实际3份前端源码+2份live-native交付件的SHA-256与F02 manifest全部一致。详情见`source-sync.json`。
- 实际调用`buildFrontendAssets`读取当前前端成功；生成JS与app.live-native.js逐字相同，HTML归一化nonce/token占位符后与index.live-native.html相同。
- shared backend与Codex工作后端的frontend/http/hub/quality/workspace/start入口逐文件哈希一致。
- 7项桥接单测通过、36断言。注意此单测使用最小锚点fixture；实际源码兼容性由上项独立调用验证。
- 独立复跑Antigravity脚本的7个场景，实际后端、SQLite、Git、HTTP、SSE及真实Chrome均运行，脚本exit0，无pageexception。证据在`rerun/`和`chrome-rerun.log`。
- 复跑仅修改脚本副本的导入/输出目录和随机测试token，并增加证据边界标记；原脚本、原证据、Antigravity前端及其brain目录未修改。

## 必须修复的发现

### R1 [P1] 交互证据被扩大为真实模型和正式沙箱验收

位置：`tests/verify-live-f02-i01.ts` 的planner/testRunner/spawn注入（约第186、212、235行）；`Antigravity/evidence/live-f02-i01-verification.md`第2/3节。

脚本planner返回固定DraftPlan；spawn忽略正式Codex命令，执行预写worker，直接写clamp并固定approve；testRunner直接spawn执行仓库脚本，绕过正式`runTestProfile`的OS隔离、超时及取消实现。因此它能证明真实控制器+HTTP+Chrome在受控provider下的交互，不能证明真实模型拆解/开发/独立审查，也不能证明此次浏览器验证运行了正式独立沙箱。executionMode=live不足以证明执行器未被注入替换。

修改要求：将原报告明确标为“真实控制器/HTTP/Chrome，provider与planner为受控替身、testRunner替换”；单独补做或链接已经存在的真实CLI/正式沙箱证据，并明确其覆盖范围。此前Codex真实HTTP成功路径证据仍有效，但不能替代本次全部交互路径。测试标题中的智能车视觉任务只是fixture标签；实际只实现clamp，不证明视觉系统已交付。

### R2 [P1] 下载预览文本会改变受控产物字节与哈希

位置：`apps/web/public/app.js:1426` 下载处理，及live-native对应代码。

下载使用artifactContentCache重新构造text/plain Blob。缓存已发生JSON格式化或UTF-8解码，不能保留原始JSON格式和二进制数据。独立复现：原始`{"ok":true}`的SHA为4062edaf...，下载后为c3a4ad9c...，`bytesPreserved=false`，完整值见source-sync.json。点击下载按钮不等同于验证落盘字节。

修改要求：下载单独携带Bearer fetch原产物，检查HTTP成功，使用response.blob()/arrayBuffer原字节；保留MIME，并以下载字节SHA-256对比Artifact.sha256后再保存。预览格式化仅用于显示。增加实际浏览器下载事件/文件存在及哈希一致断言，至少覆盖紧凑JSON与含非UTF8字节的二进制fixture；错误响应不得作为成功文件下载。

### R3 [P1] sanitizeExecutablePlan静默丢失传递依赖并改变任务语义

位置：`apps/web/public/app.js:139`、创建调用约第1577行；live-native相同。

输入A(implementation)->B(analysis)->C(implementation)，过滤B后C.dependsOn变为空，本应保留的A->C依赖丢失。独立VM复现已归档。删除节点还会无提示删除该节点的描述和验收条件；全被过滤时返回undefined会触发服务端重新规划，执行计划不再是用户看到的预览。

修改要求：优先在预览/创建时明确拒绝不受支持的analysis或保留code，要求重新生成符合契约的计划；不要静默删任务或依赖。若确需压缩节点，必须保留传递依赖、确认任务语义并重新预览。补上A->analysis->C与全节点被过滤的检查。

### R4 [P2] JSON产物的data字段被误判为API包装导致正文丢失

位置：`apps/web/public/app.js:130`的/content分支。

原始JSON产物`{"data":"payload","metadata":"must survive"}`被返回为单独字符串`payload`，metadata丢失；这是合法原始文件，并非{data,requestId}接口包装。已直接运行实际apiRequest函数复现。

修改要求：/content走独立原始字节/文本路径，在业务API解包前分流；不要根据JSON内有data字段判定包装。增加data字段JSON、JSON字符串、普通文本的预览检查。原始下载和显示格式化需分开。

### R5 [P2] drained迟到日志检查有明确反证，不能标PASS

位置：原报告Check7、脚本约第664/668行、原始与复跑JSON的cancelAndDrainedLogs.task2Cancelled。

两轮JSON均为hasDrainedLog=false，而成功predicate只断言cancelled和logCount>=1，完全没有要求drained=true。现有证据仅证明取消终态与已有日志显示，未证明SIGTERM后的迟到日志刷出及标记。当前运行器可能有意丢弃取消后的事件；是否支持drained需要先核对并形成一致契约。

修改要求：将报告“drained已验证”撤回为未覆盖，或在明确后端支持后增加真实日志内容+drained标记+终态不回退断言。不得只将hasDrainedLog字段写入JSON而不参与断言。

## 哈希同步结果

已新增后端`docs/hub/frontend-source-lock.json`，记录前端3文件、native2文件、6个关键后端文件哈希及`reviewStatus=changes-requested`。这是复核记录，不改运行时桥逻辑，也不等同于启动时强制哈希锁定。原B04-B06历史交付与其SHA256.json保持原样，避免篡改旧证据。

当前F02 manifest的5个哈希可接受为本轮待修复基线。修复后请重新生成两份native、manifest及新交互证据，Codex再同步新哈希，不能沿用旧哈希或覆盖旧结果伪装为同一轮。

## Antigravity返工顺序与验收条件

1. R2/R4共用原始产物读取入口修复，补字节哈希与JSON data用例。
2. R3避免静默改写计划，补传递依赖与空计划用例。
3. R1/R5校正文档与脚本断言，按真实/受控provider及正式/替换沙箱分层记录证据。
4. 输出新F02修订manifest/源码/native/测试报告到独立修订目录，并在交接进度标明修订号。

本次不重新调用真实模型、不扩展至Windows或压力测试，也未修改Antigravity源码。临时Chrome与受控服务已由测试清理。用户既有B04-B06真实CLI成功路径证据不因本次发现失效；整个产品尚不能按“全交互真实模型最终验收完成”签收。
