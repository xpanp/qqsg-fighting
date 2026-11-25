# 数据与未来同步边界

`types.ts` 是第一阶段实际使用的数据约定，当前 schemaVersion 为 1。UTC 毫秒用于存档，relativeMs 用单调时钟计算会话时长；可解析的游戏时间单独保存在 gameTime，不冒充采集时间。

消息 ID 表示一次观察到的消息事件。修订保持 ID 并递增 revision；首次/最近来源帧与观察次数随本地记录保存。帧完整图像不进入未来文字上传契约。

未来 Go HTTP 接收批次采用 SyncBatch，按 sourceId + 消息 ID + revision 幂等处理，SyncAck 逐项确认；只有确认后才能标记同步成功。认证、端点、重试与 SSE 协议在后端阶段再细化。第一阶段没有传输实现，不发送 SyncBatch，也不伪造回执。

第二阶段已在本地实现 wire v2：[sync.ts](sync.ts) 与 [Go API](../backend/api.md)。本地 `types.ts`/录像数据库仍是 v1，保留的 SyncBatch v1 只是旧预留接口，不作为实际上行协议。新协议独立 source/session、时间上下文、逐项确认和拒绝，服务端只在事务提交后确认；同 revision 的稳定正文冲突拒绝，观察次数等变动不冒充正文修订。sourceId 由采集凭据限制。端到端实际 JSON 验证见 [测试记录](../docs/tasks/2026-11-24-phase-2-validation.md)。
