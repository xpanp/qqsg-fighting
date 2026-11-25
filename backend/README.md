# Go 后端（本地实现，未部署）

与 frontend 同仓维护。提供单 admin、采集凭据、文字接收/修订幂等、业务事件关联、名单/黑名单、可重算统计与 Excel。尚无普通用户注册，不接收视频或截图。

入口 `cmd/server`；`internal/httpapi` 处理路由/权限；`processing` 为无数据库依赖的处理算法；`store` 封装接收、配置、审计与单 worker 的快照/事务发布，按职责分文件。初始 SQL 位于 `internal/store/migrations`，遇未来未知版本拒绝启动。

运行/名单/备份与部署：[指南](../deploy/phase2.md)。协议：[api.md](api.md)。规格：[SPC-0006](../docs/spc/0006-server-collection-and-admin.md)。用户在本地验证结束后追加授权发布；数据库、秘密及真实文字不提交。
