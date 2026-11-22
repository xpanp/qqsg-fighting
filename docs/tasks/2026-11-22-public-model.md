# 模型权重改为公开源

需求：网页继续在自有服务器维护，仅模型权重直接使用公开下载链接，减少本站流量。

实现：生成的 models/model.json 增加 url，固定到 ModelScope RapidAI/RapidOCR v3.10.0；worker 直接跨域 fetch，保留 SHA256 校验、进度和旧缓存键。字典和 ONNX 运行库仍同源。公开源错误不静默回退至本站。

准备脚本不再下载权重，并且只删除旧版中校验一致的已知生成权重，避免 Vite 把历史 public 文件继续打包。部署检查 manifest 公开地址及包内不得有 ONNX 文件。

验证：HEAD 返回 Access-Control-Allow-Origin: *；生产构建不含 ONNX 权重。使用此前未使用的本机端口 8780（独立存储 origin）在 COOP/COEP 隔离环境中冷启动，实际显示模型下载、校验完成并进入 GPU 就绪，确认跨域 GET 可用。65 项独立回归、类型检查和生产构建通过；Review 确认无静默本站回退。长期公开源可用性不作保证。
