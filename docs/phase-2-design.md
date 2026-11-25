# 第二阶段设计：服务端收集与管理分析（待实施）

初版日期：2026-11-24；实施更新：2026-11-25。需求及验收以 [SPC-0006](spc/0006-server-collection-and-admin.md) 为准；决策见 ADR-0006—0008。前端 sync/admin、Go 收集/处理和本地测试已落地；以下目录表中的服务器发布/配置路径仍是规划，未创建或部署。用户明确本轮只做本地，不修改服务器。

落地差异：本期单 worker 的任务/事务协调位于 store 包，按接收、配置、纠错、任务与查询分文件；没有创建空 jobs/ingest 子包。运行参数采用 CLI/systemd 模板，尚未引入 server.toml 或完整用户表。名单版本以数据库为准，文件快照可导入/恢复；查询和本地队列存在明确预算。详细操作见 [本地指南](../deploy/phase2.md)。

## 模块与数据流

```text
现有 capture → 视频 journal → 本地视频/时间文件（保持）
现有 OCR → 本地消息合并 → 本地消息存储/文件（保持）
                              ↓ 非阻塞通知 + 补入扫描
                         sync/outbox → 批量 HTTP
                                              ↓
Go ingest → 来源消息/修订 + 持久任务 → reconcile → battle parser
                                                    ↓
                                    names/config → events → stats
                                                    ↑          ↓
                               管理员纠错/审计    管理 API / SSE / Excel
```

前端新增 `sync/`（outbox、协议映射、重试、校时）和 `admin/`（登录、战报、统计、配置）；复用现有 TypeScript/Vite，不为管理页再引入一套应用框架。管理页单独入口构建、公开页不加载其业务模块；安全以 API 鉴权为准，代码拆包不构成保密。

后端实施时建立：

```text
backend/
  cmd/server/          服务入口
  internal/
    httpapi/           路由、校验、鉴权、错误与 SSE
    auth/              admin 会话、采集凭据
    ingest/            校时、接收与幂等回执
    reconcile/         多来源消息关联与修订
    battle/            地图击杀提取与判定
    names/             标准名、别名、阵营、黑名单
    stats/             查询、聚合与 Excel
    jobs/              持久任务、重算与版本切换
    store/             SQL、事务与数据访问
    config/            运行配置、配置集验证
  migrations/          编号 SQL，已发布迁移不重写
  testdata/            合成/脱敏回归样例
config/examples/       名单及运行配置模板，不放真实人员/密码
contracts/             协议文档/版本和前后端对照测试
deploy/                Nginx/systemd 模板、升级/备份/恢复说明
```

函数/模块职责分开，单个服务串起流水线，不把当前 Python 临时路径或特殊人名硬编码进 Go。实施前核对仍有效的脚本，算法迁移通过样例比较。

## 仓库与服务器目录

项目继续位于 `D:\dev\qqsg-fighting`，后端与前端同仓；不把旧 `fighting2` 的录像、模型或实验缓存搬进 Git。测试数据用合成或脱敏样例。

沿用既有静态发布根 `/var/www/qqsg-fighting`，实际 Nginx location 在实施前重新检查：

| 规划路径 | 内容 | 边界 |
| --- | --- | --- |
| `/var/www/qqsg-fighting/releases/<commit>/web/` | 前端构建 | 仅此静态资源可公开 |
| `/var/www/qqsg-fighting/releases/<commit>/bin/` | Go 二进制 | 不进入静态 root |
| `/var/www/qqsg-fighting/current` | 指向当前 release | 保留旧 release 回滚；切换前检查旧脚本兼容 |
| `/etc/qqsg-fighting/server.toml` | 监听、功能开关、存储与保留策略 | 服务账号只读，秘密另文件严格权限 |
| `/etc/qqsg-fighting/secrets/` | Cookie 签名等部署秘密 | 非 Git、非静态目录 |
| `/var/lib/qqsg-fighting/db/` | SQLite 数据及 WAL/SHM | 仅服务账号；升级不可覆盖 |
| `/var/lib/qqsg-fighting/names/versions/<id>/` | 三份名单、别名、黑名单的版本快照 | 与数据库版本对照，不允许无版本热改 |
| `/var/lib/qqsg-fighting/exports/` | 有期限的管理导出 | 授权下载，不暴露静态路径 |
| `/var/lib/qqsg-fighting/backups/` | 一致性数据库及名单备份 | 设置保留上限；再同步异机备份，具体目的地实施前确认 |
| systemd journal | 运行/错误日志 | 轮转，不记录令牌或完整聊天 |
| `/etc/systemd/system/qqsg-fighting.service` | Go 服务管理 | 独立低权限服务账号，只监听 `127.0.0.1` |

不在本次文档任务创建上述服务器路径。现有 release 平铺静态文件与计划的 web/bin 布局不同；升级脚本需明确兼容迁移并验证原首页不受影响，禁止直接套新路径切断现网。

## 数据模型职责

| 实体 | 必要内容/关系 |
| --- | --- |
| admin / auth_sessions | 单 admin 密码哈希、服务端会话、到期及撤销；以后扩展角色 |
| collector_credentials / sources | 凭据哈希、来源授权、启停和后续可空 owner_user_id；不信任客户端自报身份 |
| capture_sessions | 来源、客户端/服务端时间锚点、校时质量；游戏服务器/区服和线路上下文（未知单独标记） |
| source_message_revisions | 来源/会话/消息 ID/revision 唯一，原文、首末观察时间、游戏时间、帧引用、接收时间和内容摘要 |
| canonical_messages / message_sources | 多来源标准播报、所有支持证据、合并/拆分状态及算法版本 |
| characters / name_config_versions | 稳定角色 ID、展示名、别名、阵营、黑名单及版本；改名不生成无关联新角色 |
| battle_events / event_sources | 发生时间/不确定区间、击杀者/死者原始及标准名、频道、计入状态和原因、来源、配置/算法版本 |
| event_overrides / audit_log | 人工修正、拆并、操作者、原因及前后值；原文不可覆盖 |
| jobs / projection_versions | 待处理、重试、重算范围、进度、失败原因和当前发布统计版本 |
| battles | 可选场次、标题、区间、所属活动；本期可无场次，事件保留可空 battle_id |

区服和线路会影响能否视为同场播报；前端应允许设置会话上下文，未知值保留待确认，不能跨区服/不同线路仅凭相近时间合并。未来用户、场次关联不靠文件名或昵称拼接主键。

时间存 UTC，管理员默认 Asia/Shanghai 展示，查询时间含明确偏移；所有区间使用 `[start,end)`。游戏 HH:mm:ss 结合采集日期推断，保留原字符串和跨午夜/误差证据。断网晚到不以 received_at 冒充 event_at。原文、修订、人工覆盖和配置版本默认持续保留；导出/日志可过期，策略变更须显式操作及备份，不沿用缓存清理规则删除业务证据。

## 接口规划

统一同源前缀 `/fighting/api/v1/`，与静态模型和首页代理隔离。以下仅为接口设计，实施时形成可测试契约。

| 接口 | 权限 | 语义 |
| --- | --- | --- |
| `POST ingest/batches` | 采集凭据 | 有界消息批次；事务提交后逐项 accepted/rejected/retryable 回执 |
| `GET time` | 采集凭据/admin | 服务端 UTC；客户端记录往返时间与偏差估计 |
| `POST admin/login`、`POST admin/logout`、`GET admin/session` | 登录/会话 | 限流、Cookie、退出及 CSRF 状态 |
| `GET admin/events`、`GET admin/messages/:id` | admin | 分页/时间筛选、解析结果及原始来源 |
| `GET admin/stream` | admin | SSE 带持久游标，重连补发；游标过期重新获取快照 |
| `GET admin/stats`、`POST admin/exports` | admin | 同一查询语义/版本，导出 Excel |
| `GET/POST admin/name-configs` | admin | 查看、导入、校验及启用名单版本 |
| `POST admin/event-overrides`、`POST admin/reprocess` | admin | 幂等修改、审计、限定范围重算与进度 |
| `POST admin/collector-credentials` | admin | 生成/撤销采集凭据，秘密仅创建时显示 |

管理员 Cookie 不接受作任意采集身份；采集 Bearer 凭据不能调用 admin 路由。POST 写操作有 CSRF/来源校验；不把 Bearer 放查询字符串。SSE 仅管理员使用、设置反向代理缓冲/超时及心跳；断连不影响服务处理。公网健康信息不暴露数据库和用户名。

## 分步上线与恢复

1. 先审协议、迁移、配置与合成样例；独立验证 Go 接收和重算，不碰线上录制。
2. 部署关闭公开上传开关的后端/管理页，建立 admin、导入服务器名单，校验鉴权和备份恢复。
3. 指定少量采集来源启用同步，2—3 人对照本地文件及服务端结果，验证修订和跨来源对齐。
4. 一小时真实录制与故障注入通过，完成架构、产品和独立 Review，再发布受审同主题提交。
5. 发布不刷新正在录制的用户。问题时关闭上传、保持本地模式；静态版本、Go 版本、迁移和备份均记录。优先向前兼容迁移，数据库恢复需明确新写入损失范围，不能只切二进制假称回滚完成。

当前无后端业务测试、压测、服务器变更或独立审查证据；这些是实现阶段的交付任务。

授权与证据更新（2026-11-25）：本地自动验证及独立审查已完成，见 SPC-0006 和验证报告；用户随后追加服务器发布授权。部署实际版本/备份/检查记录在发布回执，不将本设计初稿的“未实施”描述当作当前功能状态。
