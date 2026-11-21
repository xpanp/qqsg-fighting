# 后端边界（尚未实现）

后续 Go 服务与 frontend 同仓维护，负责账号、消息批量接收/幂等回执、多人消息合并、SSE 订阅、查询统计及导出。

第一阶段仅 Nginx 静态分发，不运行 Go 服务、不创建数据库、不接收录像或 OCR 文字。数据边界见 ../contracts/types.ts 和 ../docs/architecture.md；实施时再建立 cmd/、internal/ 和接口文档。
