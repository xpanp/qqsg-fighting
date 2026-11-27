# Go 后端

> 公共自动接入与10活跃来源限制已完成本地验证，本轮尚未部署；状态与验收见 [SPC-0008](../docs/spc/0008-automatic-collector-and-source.md)。

与 frontend 同仓维护。提供单 admin、采集凭据、文字接收/修订幂等、业务事件关联、名单/黑名单、可重算统计与 Excel。尚无普通用户注册，不接收视频或截图。

公共浏览器可通过同源 `collectors/register` 自动领取独立、可撤销、只写采集凭据，无需填写接入配置；这不是玩家账户。默认最多 10 个来源同时上传，超额客户端继续本地录制并稍后重试；活跃租约 2 分钟。`--public-registration=false` 可关闭新访客接入，`MAX_ACTIVE_COLLECTORS` 或 `--max-active-collectors` 调整上限。角色名是本地 OCR 观察值，不作为认证。详细限流与返回值见 API 文档。本轮实现状态由 SPC-0008 和部署记录分别说明，不以本地代码完成代表已上线。

入口 `cmd/server`；`internal/httpapi` 处理路由/权限；`processing` 为无数据库依赖的处理算法；`store` 封装接收、配置、审计与单 worker 的快照/事务发布，按职责分文件。初始 SQL 位于 `internal/store/migrations`，遇未来未知版本拒绝启动。

运行/名单/备份与部署：[指南](../deploy/phase2.md)。协议：[api.md](api.md)。规格：[SPC-0006](../docs/spc/0006-server-collection-and-admin.md)。用户在本地验证结束后追加授权发布；数据库、秘密及真实文字不提交。
