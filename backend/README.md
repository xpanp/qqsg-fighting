# Go 后端

> 公共自动接入与10活跃来源限制已完成本地验证，本轮尚未部署；状态与验收见 [SPC-0008](../docs/spc/0008-automatic-collector-and-source.md)。

与 frontend 同仓维护。提供单 admin、采集凭据、文字接收/修订幂等、业务事件关联、名单/黑名单、可重算统计与 Excel。尚无普通用户注册，不接收视频或截图。

公共浏览器可通过同源 `collectors/register` 自动领取独立、可撤销、只写采集凭据，无需填写接入配置；这不是玩家账户。默认最多 10 个来源同时上传，超额客户端继续本地录制并稍后重试；活跃租约 2 分钟。`--public-registration=false` 可关闭新访客接入，`MAX_ACTIVE_COLLECTORS` 或 `--max-active-collectors` 调整上限。角色名是本地 OCR 观察值，不作为认证。详细限流与返回值见 API 文档。本轮实现状态由 SPC-0008 和部署记录分别说明，不以本地代码完成代表已上线。

入口 `cmd/server`；`internal/httpapi` 处理路由/权限；`processing` 为无数据库依赖的处理算法；`store` 封装接收、配置、审计与单 worker 的快照/事务发布，按职责分文件。初始 SQL 位于 `internal/store/migrations`，遇未来未知版本拒绝启动。

运行/名单/备份与部署：[指南](../deploy/phase2.md)。协议：[api.md](api.md)。规格：[SPC-0006](../docs/spc/0006-server-collection-and-admin.md)。用户在本地验证结束后追加授权发布；数据库、秘密及真实文字不提交。

## SPC-0010 本地运行

账号模式通过 `--account-key-file <绝对路径>` 启用。文件内容为 32 字节随机密钥，存放在仓库之外，仅运行服务的账号可读。先备份旧数据库，并单独保存密钥的受保护副本。首次初始化仍使用既有 `--init-admin` 流程。部署时匹配使用本次账号版前端和服务端，回滚时同时切换前后端。未启用账号模式的 Go 服务继续支持原版客户端。

账号模式下每日一致性备份写入数据目录的 `backups/daily`，默认保留 30 份。数据库与解密密钥分别备份。恢复数据库可保留登录哈希，查看密码原文还需要原密钥。

同一个 Go 可执行程序也能离线出报表：

```powershell
qqsg-server.exe report --input D:/data/messages.txt --roster D:/data/roster --output D:/data/report.xlsx --timezone Asia/Shanghai --self-name 我的角色
```

名单目录使用 `name_a.txt`、`name_b.txt`、`name_others.txt`，可加 `blacklist.txt` 和 `aliases.tsv`。别称表首列是标准名，后续列是别名，使用 Tab 分隔。旧 fighting2 别称表的原名列在前，导入前需交换方向。TXT 每行以本地采集日期和时间开头，时间与消息用两个空格分隔。`--self-name` 仅用于单视角 TXT。多视角输入使用 SourceMessage JSON 数组，逐条保留采集来源、事件时间和来源角色。输出包括新建的 Excel 和同名 `.xlsx.json` 摘要，两者都使用独立输出路径。
