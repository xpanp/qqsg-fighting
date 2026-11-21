# 数据与未来同步边界

`types.ts` 是第一阶段实际使用的数据约定，当前 schemaVersion 为 1。UTC 毫秒用于存档，relativeMs 用单调时钟计算会话时长；可解析的游戏时间单独保存在 gameTime，不冒充采集时间。

消息 ID 表示一次观察到的消息事件。修订保持 ID 并递增 revision；首次/最近来源帧与观察次数随本地记录保存。帧完整图像不进入未来文字上传契约。

未来 Go HTTP 接收批次采用 SyncBatch，按 sourceId + 消息 ID + revision 幂等处理，SyncAck 逐项确认；只有确认后才能标记同步成功。认证、端点、重试与 SSE 协议在后端阶段再细化。第一阶段没有传输实现，不发送 SyncBatch，也不伪造回执。
