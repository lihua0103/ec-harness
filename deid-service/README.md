# DeID Service - 本地文档脱敏服务

## 快速启动

```bash
cd deid-service
python app.py
```

访问 http://localhost:8088

## 配置要求

- Python 3.13+
- torch 2.x (已安装)
- 内存: 32GB RAM (你的配置满足)
- GPU: 可选（CPU 模式可用）

## 首次运行

首次启动会自动下载 Qwen2.5-3B-Instruct 模型 (~6GB)。