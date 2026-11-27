# 架构决策记录（ADR）

每份文件记录一个重要决策，使用 `NNNN-short-name.md`，从 [ADR 模板](../templates/ADR.md) 创建。需求规格放 [SPC](../spc/README.md)，不把所有需求说明都塞进 ADR。

| 编号 | 决策 | 状态 | 关联规格 |
| --- | --- | --- | --- |
| [ADR-0001](0001-browser-local-processing.md) | 浏览器本地处理与前后端同仓 | 已采纳，历史补录 | SPC-0001 |
| [ADR-0002](0002-local-durability-and-snapshots.md) | 视频先暂存再落盘，消息保存修订快照 | 已采纳，历史补录 | SPC-0001、0002 |
| [ADR-0003](0003-adjacent-message-reconciliation.md) | 按相邻视口对齐、修订消息 | 已采纳，历史补录 | SPC-0001、0004 |
| [ADR-0004](0004-public-model-distribution.md) | 模型公网下载，页面和运行库同源 | 已采纳，历史补录 | SPC-0003 |
| [ADR-0005](0005-documentation-records.md) | SPC 与 ADR 分目录维护 | 已采纳，用户本次明确要求 | SPC-0005 |
| [ADR-0006](0006-durable-message-sync.md) | 独立持久队列、修订幂等与时间证据 | 已采纳，本地实现/验证 | SPC-0006 |
| [ADR-0007](0007-server-processing-and-admin.md) | Go 单服务、可重算数据与管理鉴权 | 已采纳，本地实现/验证 | SPC-0006 |
| [ADR-0008](0008-business-event-identity.md) | 业务事件身份、同源重复与人工关联证据分离 | 已采纳，实施中真实回放与 Review | SPC-0006 |
| [ADR-0009](0009-recorder-resource-isolation.md) | 分段编码器串行切换与录像优先 | 已采纳，本地未部署 | SPC-0007 |
| [ADR-0010](0010-public-collector-admission.md) | 公共访客接入与活跃来源限额 | 已采纳，本地验证通过，未部署 | SPC-0008 |
| [ADR-0011](0011-observed-source-and-sync-epochs.md) | 观测来源与同步逻辑会话 | 已采纳，本地验证通过，未部署 | SPC-0008 |

编号递增，不因文件删除、拒绝或方案被取代而重用。新 ADR 说明背景、选项、结论、后果及如何验证；不要只记录最终方案。改变已采纳决策时新建记录，链接 `取代/被取代` 关系，并同步当前架构文档。小修复可以没有新 ADR，只需在 SPC 关联沿用的决策。

前四份于 2026-11-24 据现有实现和历史记录补录，替代方案是便于理解取舍的回顾分析，不意味着当时已有逐项试验或正式比较。若未来引入用户/同步/Go 服务，需在新需求中另行记录接口、身份及数据去重等决策。
