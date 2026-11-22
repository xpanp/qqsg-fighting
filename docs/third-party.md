# 第三方资源

生产页面不调用在线 OCR，不包含第三方分析或遥测脚本。

| 资源 | 来源与版本 | 许可 |
| --- | --- | --- |
| PP-OCRv6_rec_medium 与字典 | PaddleOCR，RapidAI/RapidOCR ModelScope v3.10.0 的 ONNX 转换资源 | 上游 PaddleOCR / RapidOCR Apache-2.0，保留随部署提供的许可 |
| ONNX Runtime Web | npm onnxruntime-web 1.31.1 | MIT |
| Vite / TypeScript / tsx | package-lock.json 锁定；开发构建使用 | 分别遵循各包许可 |

模型 SHA256：`eef444829dbbe18d7fea59a3f6eb75647518d2b3a9568d27c92e42940204894b`。

字典 SHA256：`b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d`，18708 条词表项，加 CTC blank 与空格后 18710 类。

准备脚本 scripts/prepare-assets.mjs 生成固定版本 ModelScope 权重公开链接，浏览器直接下载并校验；脚本仅下载字典，运行库从锁定的 npm 依赖复制。部署包不含权重；权重、字典和运行库产物不提交 Git。页面使用的预处理与录制实现来自本项目验证版，非上游模型源码修改。
