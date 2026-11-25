# 第二阶段运行与部署检查

更新：2026-11-25。代码已用于本地隔离验证；本文件不是现网已部署的证据。现网仍使用第一阶段静态布局，未经迁移不能直接替换 Nginx snippet。

本地阶段结束后，用户于同日追加授权部署。新入口 `scripts/deploy-phase2.ps1` 要求干净受审提交，构建并打包 web/bin、私有上传、初始化单 admin、以旧绝对 web root 桥接布局迁移，再健康检查切换。首次凭据只保存在本地 `.tools/deployment/admin-credentials.txt`，不进入 Git；实际发布回执按 commit 放在 `.tools/deployment` 及服务器 release 的 `deployment.txt`。

## 本地开发

项目根目录执行（Node >=22.12、Go >=1.23；本机 Go 在 `.tools/go`）：

新检出代码先执行 `npm ci`、`npm run prepare:assets`；资源脚本生成公开模型清单并准备字典/运行库，不下载模型权重。然后初始化本地服务：

```powershell
# 首次初始化本地 admin；密码交互输入，不进入命令行参数。
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev-phase2.ps1 -InitAdmin
```

另开终端执行 `npm run dev`（本机也可 `node .tools/npm/bin/npm-cli.js run dev`），访问 `http://127.0.0.1:5173/fighting/` 和私有管理入口 `http://127.0.0.1:5173/fighting/admin/`。Vite 将 API 转发到 8780；若端口被占用，先停止冲突进程，不能自动换端口而仍使用旧 Origin。后续启动省略 `-InitAdmin`，该开关会重设密码并撤销管理员会话。运行数据保存在项目 `.tools/local-server`，不混入源码和真实录像。

可从管理页维护名单，也可将文件放在独立目录后用 `-NamesDirectory <绝对目录>` 导入。包含 `name_a.txt`、`name_b.txt`、`name_others.txt`，可选 `aliases.tsv`、`blacklist.txt`；别名是 **标准名 TAB OCR别名**。旧 fighting2 的 `name_aliases.tsv` 顺序相反，不能直接当成新格式。CLI 导入后排队重算，服务启动后执行；不读取用户其他目录。

Go 工具链可用 `scripts/setup-go.ps1` 安装到项目 `.tools`，下载并验证官方校验值；已有工具链时不会覆盖。

## 验证命令

一键执行前端、Go、独立 HTTP 及可选真实文本回放（仅本机，绝不部署/推送）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-local.ps1
# 增加当次旧文本数据作为输入：
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-local.ps1 -HistoryDirectory D:\dev\fighting2\data\runs\2026-11-21
```

```powershell
npm test
npm run typecheck
npm run build
# 在 backend 内运行；本机可使用 ..\.tools\go\bin\go.exe。
go test ./...
```

编译 Windows 测试二进制后，在根目录执行：

```powershell
node tests/phase2/run-http.mjs --binary .tools/qqsg-server-test.exe
# 可选：真实旧转写，仅进入独立本机测试数据库，不发生产服务器。
node tests/phase2/run-http.mjs --binary .tools/qqsg-server-test.exe --history-root D:\dev\fighting2\data\runs\2026-11-21
# 可选：本机已安装 Edge 的独立无头浏览器检查。
node tests/phase2/browser-smoke.mjs --binary .tools/qqsg-server-test.exe
```

普通 `npm test` 未配置 HTTP 环境时会明确跳过接口用例，不能视为接口通过。harness 启动隔离服务后才真正执行它们。全部测试运行文件、日志及数据库位于 `.tools/phase2-validation`；不提交真实名单/消息、凭据、数据库、截图或 Excel。

可选 `-BrowserSmoke` 需要能启动无头 Edge 的桌面环境。本轮 Codex 沙箱中浏览器启动失败，未标记为通过；真实窗口授权和一小时录制仍须后续本地验收。

## 生产发布边界

`scripts/build-phase2.ps1` 生成 `.tools/phase2-package/<时间>/web` 和 `bin/qqsg-server`（Linux amd64）。它只构建，不上传或启停服务器。先完成真实窗口长录制和灰度验收，再按以下次序迁移：

1. 核对现网配置、提交、备份和活动录制；原首页代理保持不变。
2. 受审 release 放 `/var/www/qqsg-fighting/releases/<commit>/{web,bin}`。持久数据放 `/var/lib/qqsg-fighting`，用独立低权限账号；真实名单不在静态目录。`deploy/qqsg-fighting.service` 为服务模板，API 仅 loopback 8780，Origin 为正式域名。
3. 用新二进制的 `--init-admin` 与环境变量 `QQSG_ADMIN_PASSWORD` 初始化单 admin，完成后移除该环境变量。不能把密码写进 unit、Git 或网页。
4. 从服务器受控目录导入三份名单/别名/黑名单，DB 中的版本为准，文本快照保存到 `names/versions/<id>`；直接改快照不会热更新，需重新导入或管理页保存。
5. 将旧 release 的 hashed `assets` 和新 assets 合并到 `/var/www/qqsg-fighting/shared/assets`，不删除旧资源；这使已经打开的录制页仍能加载旧 Worker。模型 manifest/vendor 路径保持兼容。
6. 备份 Nginx snippet；检查 `nginx-phase2.conf` 的 API 与 web/bin 布局，`nginx -t` 后才切换 current/reload。API 不可用不应影响静态页。不推送强制刷新到活动录制页。
7. 从少量持有采集凭据的来源启用同步；检查鉴权、SSE、停止保存、服务中断恢复及统计版本。普通用户不需注册；同步凭据不嵌入公开 JS，管理员私下分发，网页清楚说明上传文字。

新发布使用 `scripts/deploy-phase2.ps1 -HostAlias tx [-NamesDirectory <新格式名单目录>]` 和 `deploy/install-phase2.sh`，不把旧 `scripts/deploy.ps1` 用于新布局。自动脚本保留旧资源、配置和 service 状态备份，失败退出并回滚代码/路由，不自动覆盖新业务数据。实际检查记录在发布回执，不能因为已有模板就标记“已部署”。

## 备份、恢复与运行上限

`qqsg-server --data-dir <绝对运行目录> --backup <不存在的绝对备份文件>` 使用 SQLite 一致性备份，包含原文、修订、名单配置版本、管理员凭据哈希及审计，因此备份也必须私有。不能仅复制正在运行的 `.db` 而遗漏 WAL。命令不会重排正在运行的任务。另保留 release 版本及名字文件快照；数据库恢复后可重建当前名单快照。

恢复时停止服务，在独立目录验证备份（测试已覆盖），再切换数据目录；旧 DB/WAL/SHM 整组保留，不混用不同版本文件。初始化 schema 为 1，遇更高未知版本拒绝启动，后续正式迁移必须新编号而不是改已发布 SQL。程序回滚与数据库恢复分开，不能忽略恢复点之后的新数据。

事件查询 SQL 分页；统计/Excel 单次最多 31 天、20,000 个事件或 32 MiB 事件 JSON，超出要求缩小区间，查询限时 3 秒。单服务、单 worker，未做分布式吞吐承诺。admin SSE 有并发/写入超时边界，日志包含 request/batch/source/session/job/config/projection 标识，不记录密码、令牌或完整聊天。Nginx 必须覆盖 `X-Real-IP`；Go 仅在生产 loopback 代理连接上信任合法的该字段。
