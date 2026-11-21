# 静态部署

目标：`https://jinbaofu.cn/fighting/`。保留原首页代理，增加 HTTPS server 内独立 location，不运行 Go 或业务数据库。

本机准备 Node >=22.12、npm、Windows OpenSSH 和服务器免密别名 tx。干净工作区、审查完成并提交后：

```powershell
npm ci
npm run prepare:assets
npm run build
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy.ps1 -HostAlias tx
```

脚本要求干净工作区，上传构建产物到服务器，以提交 SHA 创建 `/var/www/qqsg-fighting/releases/SHA`，校验 Nginx 后切换 current 并 reload。部署脚本适配已检查的 vaultwarden HTTPS 配置；配置结构变化时拒绝自动修改，需重新检查。服务器需 Ubuntu 的 nginx、python3、tar、sudo（现有环境具备）。构建与部署都基于当前受审提交，不从未提交工作区发布。

部署检查：

- `/fighting/` 返回 HTML；`version.json` 对应提交 SHA。
- HTTPS 下 crossOriginIsolated 为 true，模型、Worker 和 WASM 同源加载。
- `.wasm` 返回 application/wasm；模型下载并校验通过；无业务 POST 或第三方请求。
- 首页 `/` 仍走原业务代理。
- 实际浏览器录制、保存与识别检查，未执行项记入阶段验收。

模型较大，Nginx 使用 no-cache 允许校验；浏览器模型 Cache API 按 SHA 缓存。模型与库的许可随 public/licenses 一起发布。

回滚：读取当前版本 deployment.txt 的 previous 和 nginx_backup。先确认路径属于本工具，再将 current 链接切回对应旧 release；必要时恢复所记录的 Nginx 配置备份，`sudo nginx -t` 成功后再 `sudo systemctl reload nginx`。首次部署无旧 release 时，恢复 Nginx 备份即可撤掉此路径。不要删除录像或修改无关站点。
