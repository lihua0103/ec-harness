"""
DeID Service - 本地文档脱敏服务
基于 Qwen2.5-3B-Instruct (CPU) + 规则引擎
"""
import json
import re
import time
import os
import tempfile
from pathlib import Path
from typing import List, Dict, Optional
from dataclasses import dataclass, asdict

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import uvicorn

# ============ 配置 ============
MODEL_NAME = "Qwen/Qwen2.5-3B-Instruct"
MAX_TEXT_LENGTH = 4000  # 单次处理最大文本长度
CHUNK_SIZE = 2000  # 分块处理避免超长

# ============ 脱敏实体类型 ============
ENTITY_TYPES = {
    "SPONSOR": "申办方/公司名称",
    "PROJECT": "项目名称",
    "PERSON": "人名",
    "ADDRESS": "地址/机构",
    "DATE": "日期",
    "ID": "编号/版本号",
    "OTHER": "其他敏感信息",
}

# ============ 规则引擎 ============
RULE_PATTERNS = {
    "SPONSOR": [
        r"(?:申办方|赞助方|sponsor)[:：]\s*([^\n]{2,30})",
        r"([A-Za-z一-龥]{2,20}(?:制药|生物|医药|科技|有限|集团|股份))",
    ],
    "PROJECT": [
        r"(?:项目名称|项目名|project)[:：]\s*([^\n]{2,40})",
        r"(?:Study|Trial|Protocol)\s+([A-Z][A-Za-z0-9\-]+)",
    ],
    "PERSON": [
        r"([A-Za-z一-龥]{2,4})\s*(?:博士|教授|医生|研究员|PI|负责人)",
    ],
    "DATE": [
        r"\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?",
    ],
    "ID": [
        r"(?:编号|编号|协议号|版本)[:：]\s*([A-Za-z0-9\-]+)",
    ],
}

# ============ 数据结构 ============
@dataclass
class Entity:
    text: str
    type: str
    start: int
    end: int
    confidence: float
    replaced: str = ""

@dataclass
class DeidResult:
    original: str
    deidentified: str
    entities: List[Dict]
    processing_time: float
    model_used: str

# ============ 模型管理 ============
class ModelManager:
    def __init__(self):
        self.model = None
        self.tokenizer = None
        self.loaded = False

    def load(self):
        if self.loaded:
            return
        print(f"Loading {MODEL_NAME}...")
        self.tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME, trust_remote_code=True)
        self.model = AutoModelForCausalLM.from_pretrained(
            MODEL_NAME,
            torch_dtype=torch.float32,
            device_map="cpu",
            trust_remote_code=True,
        )
        self.loaded = True
        print("Model loaded successfully!")

    def generate(self, prompt: str, max_new_tokens: int = 512) -> str:
        if not self.loaded:
            self.load()
        messages = [
            {"role": "system", "content": "你是一个专业的文档脱敏助手。识别并提取需要脱敏的敏感信息。"},
            {"role": "user", "content": prompt}
        ]
        text = self.tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = self.tokenizer(text, return_tensors="pt").to("cpu")
        with torch.no_grad():
            outputs = self.model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                temperature=0.1,
                do_sample=False,
            )
        response = self.tokenizer.decode(outputs[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)
        return response

model_manager = ModelManager()

# ============ 脱敏引擎 ============
class DeidEngine:
    def __init__(self):
        self.entity_counter = {}

    def rule_based_extract(self, text: str) -> List[Entity]:
        """基于规则的实体提取"""
        entities = []
        for etype, patterns in RULE_PATTERNS.items():
            for pattern in patterns:
                for match in re.finditer(pattern, text):
                    entity_text = match.group(1) if match.groups() else match.group(0)
                    entities.append(Entity(
                        text=entity_text.strip(),
                        type=etype,
                        start=match.start(),
                        end=match.end(),
                        confidence=0.95,
                    ))
        return entities

    def llm_extract(self, text: str) -> List[Entity]:
        """基于 LLM 的语义实体提取"""
        prompt = f"""请从以下临床文档中识别并提取需要脱敏的敏感信息。

需要脱敏的类型：
- SPONSOR: 申办方/公司名称（如 pharmaceutical companies, biotech firms）
- PROJECT: 项目/研究名称（如 clinical trial names）
- PERSON: 人名（研究人员、医生等）
- ADDRESS: 地址、机构名称
- OTHER: 其他敏感信息

文档内容：
{text}

请以 JSON 数组格式输出，每个元素包含 text 和 type 字段。只输出 JSON，不要其他内容。
示例：[{{"text": "XX制药", "type": "SPONSOR"}}, {{"text": "EMPA-KIDNEY", "type": "PROJECT"}}]
"""
        try:
            response = model_manager.generate(prompt, max_new_tokens=1024)
            # 提取 JSON
            json_match = re.search(r'\[.*\]', response, re.DOTALL)
            if json_match:
                items = json.loads(json_match.group())
                entities = []
                for item in items:
                    if isinstance(item, dict) and "text" in item and "type" in item:
                        # 在原文中定位
                        idx = text.find(item["text"])
                        if idx != -1:
                            entities.append(Entity(
                                text=item["text"],
                                type=item["type"],
                                start=idx,
                                end=idx + len(item["text"]),
                                confidence=0.85,
                            ))
                return entities
        except Exception as e:
            print(f"LLM extraction error: {e}")
        return []

    def deduplicate(self, entities: List[Entity]) -> List[Entity]:
        """去重，保留置信度高的"""
        seen = set()
        result = []
        for e in sorted(entities, key=lambda x: -x.confidence):
            key = (e.text, e.type)
            if key not in seen:
                seen.add(key)
                result.append(e)
        return result

    def replace_entities(self, text: str, entities: List[Entity]) -> str:
        """替换实体为占位符"""
        # 按位置倒序替换，避免偏移
        sorted_entities = sorted(entities, key=lambda x: -x.start)
        result = text
        self.entity_counter = {}
        for e in sorted_entities:
            if e.type not in self.entity_counter:
                self.entity_counter[e.type] = 0
            self.entity_counter[e.type] += 1
            placeholder = f"[{e.type}_{self.entity_counter[e.type]}]"
            e.replaced = placeholder
            result = result[:e.start] + placeholder + result[e.end:]
        return result

    def process(self, text: str) -> DeidResult:
        start_time = time.time()

        # 分块处理长文本
        if len(text) > CHUNK_SIZE:
            chunks = [text[i:i+CHUNK_SIZE] for i in range(0, len(text), CHUNK_SIZE)]
            all_entities = []
            offset = 0
            for chunk in chunks:
                rule_entities = self.rule_based_extract(chunk)
                llm_entities = self.llm_extract(chunk)
                for e in rule_entities + llm_entities:
                    e.start += offset
                    e.end += offset
                    all_entities.append(e)
                offset += len(chunk)
            entities = self.deduplicate(all_entities)
        else:
            rule_entities = self.rule_based_extract(text)
            llm_entities = self.llm_extract(text)
            entities = self.deduplicate(rule_entities + llm_entities)

        # 替换
        deidentified = self.replace_entities(text, entities)

        elapsed = time.time() - start_time

        return DeidResult(
            original=text,
            deidentified=deidentified,
            entities=[asdict(e) for e in entities],
            processing_time=round(elapsed, 2),
            model_used=MODEL_NAME,
        )

# ============ FastAPI 应用 ============
app = FastAPI(title="DeID Service", description="本地文档脱敏服务")

engine = DeidEngine()

class TextRequest(BaseModel):
    text: str

class DeidResponse(BaseModel):
    deidentified: str
    entities: List[Dict]
    processing_time: float
    model_used: str

@app.on_event("startup")
async def startup():
    # 预加载模型
    print("Pre-loading model...")
    model_manager.load()

@app.get("/", response_class=HTMLResponse)
async def index():
    return HTMLResponse(content=HTML_PAGE)

@app.post("/api/deid", response_model=DeidResponse)
async def deid_text(request: TextRequest):
    if not request.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")
    if len(request.text) > MAX_TEXT_LENGTH:
        raise HTTPException(status_code=400, detail=f"Text too long (max {MAX_TEXT_LENGTH} chars)")
    result = engine.process(request.text)
    return DeidResponse(
        deidentified=result.deidentified,
        entities=result.entities,
        processing_time=result.processing_time,
        model_used=result.model_used,
    )

@app.post("/api/deid-file")
async def deid_file(file: UploadFile = File(...)):
    content = await file.read()
    text = content.decode("utf-8", errors="replace")
    if len(text) > MAX_TEXT_LENGTH:
        text = text[:MAX_TEXT_LENGTH]
    result = engine.process(text)
    return JSONResponse(content={
        "filename": file.filename,
        "deidentified": result.deidentified,
        "entities": result.entities,
        "processing_time": result.processing_time,
    })

@app.get("/api/health")
async def health():
    return {"status": "ok", "model_loaded": model_manager.loaded}

# ============ HTML 页面 ============
HTML_PAGE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>本地文档脱敏服务</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background: #f5f5f5;
            padding: 20px;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        h1 {
            text-align: center;
            color: #333;
            margin-bottom: 20px;
        }
        .card {
            background: white;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .input-area {
            width: 100%;
            min-height: 200px;
            padding: 12px;
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 14px;
            resize: vertical;
        }
        .btn {
            background: #007bff;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            margin-right: 10px;
        }
        .btn:hover { background: #0056b3; }
        .btn:disabled { background: #ccc; cursor: not-allowed; }
        .btn-secondary { background: #6c757d; }
        .btn-secondary:hover { background: #545b62; }
        .result-area {
            width: 100%;
            min-height: 200px;
            padding: 12px;
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 14px;
            background: #f8f9fa;
            white-space: pre-wrap;
        }
        .entities {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 10px;
        }
        .entity-tag {
            background: #e7f3ff;
            border: 1px solid #b3d7ff;
            border-radius: 4px;
            padding: 4px 8px;
            font-size: 12px;
        }
        .entity-tag .type {
            color: #0056b3;
            font-weight: bold;
        }
        .stats {
            color: #666;
            font-size: 13px;
            margin-top: 10px;
        }
        .loading {
            display: none;
            text-align: center;
            padding: 20px;
        }
        .spinner {
            border: 3px solid #f3f3f3;
            border-top: 3px solid #007bff;
            border-radius: 50%;
            width: 30px;
            height: 30px;
            animation: spin 1s linear infinite;
            margin: 0 auto 10px;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        .two-col {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
        }
        @media (max-width: 768px) {
            .two-col { grid-template-columns: 1fr; }
        }
        .file-upload {
            border: 2px dashed #ddd;
            border-radius: 8px;
            padding: 30px;
            text-align: center;
            margin-bottom: 20px;
            cursor: pointer;
        }
        .file-upload:hover { border-color: #007bff; }
        .file-upload input { display: none; }
        .highlight { background: #fff3cd; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔒 本地文档脱敏服务</h1>

        <div class="card">
            <h3>上传文件</h3>
            <div class="file-upload" onclick="document.getElementById('fileInput').click()">
                <p>点击或拖拽文件到此处上传</p>
                <input type="file" id="fileInput" accept=".txt,.md,.csv,.json" onchange="handleFileUpload(this)">
            </div>
        </div>

        <div class="two-col">
            <div class="card">
                <h3>原文输入</h3>
                <textarea id="inputText" class="input-area" placeholder="在此粘贴需要脱敏的文档内容..."></textarea>
                <div style="margin-top: 10px;">
                    <button class="btn" onclick="processText()" id="processBtn">开始脱敏</button>
                    <button class="btn btn-secondary" onclick="clearAll()">清空</button>
                </div>
            </div>

            <div class="card">
                <h3>脱敏结果</h3>
                <div id="resultText" class="result-area">等待处理...</div>
                <div id="entities" class="entities"></div>
                <div id="stats" class="stats"></div>
            </div>
        </div>

        <div id="loading" class="loading">
            <div class="spinner"></div>
            <p>正在处理中，请稍候...</p>
        </div>
    </div>

    <script>
        async function processText() {
            const text = document.getElementById('inputText').value;
            if (!text.trim()) {
                alert('请输入需要脱敏的文本');
                return;
            }

            document.getElementById('loading').style.display = 'block';
            document.getElementById('processBtn').disabled = true;

            try {
                const response = await fetch('/api/deid', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: text })
                });

                if (!response.ok) {
                    throw new Error(await response.text());
                }

                const result = await response.json();
                document.getElementById('resultText').textContent = result.deidentified;

                // 显示识别的实体
                const entitiesDiv = document.getElementById('entities');
                entitiesDiv.innerHTML = '';
                result.entities.forEach(e => {
                    const tag = document.createElement('div');
                    tag.className = 'entity-tag';
                    tag.innerHTML = `<span class="type">${e.type}</span>: ${e.text}`;
                    entitiesDiv.appendChild(tag);
                });

                document.getElementById('stats').textContent =
                    `识别 ${result.entities.length} 个敏感实体 | 处理时间 ${result.processing_time}s | 模型: ${result.model_used}`;

            } catch (error) {
                alert('处理失败: ' + error.message);
            } finally {
                document.getElementById('loading').style.display = 'none';
                document.getElementById('processBtn').disabled = false;
            }
        }

        async function handleFileUpload(input) {
            const file = input.files[0];
            if (!file) return;

            const formData = new FormData();
            formData.append('file', file);

            document.getElementById('loading').style.display = 'block';

            try {
                const response = await fetch('/api/deid-file', {
                    method: 'POST',
                    body: formData
                });

                if (!response.ok) {
                    throw new Error(await response.text());
                }

                const result = await response.json();
                document.getElementById('inputText').value = await file.text();
                document.getElementById('resultText').textContent = result.deidentified;

                const entitiesDiv = document.getElementById('entities');
                entitiesDiv.innerHTML = '';
                result.entities.forEach(e => {
                    const tag = document.createElement('div');
                    tag.className = 'entity-tag';
                    tag.innerHTML = `<span class="type">${e.type}</span>: ${e.text}`;
                    entitiesDiv.appendChild(tag);
                });

                document.getElementById('stats').textContent =
                    `文件: ${result.filename} | 识别 ${result.entities.length} 个敏感实体 | 处理时间 ${result.processing_time}s`;

            } catch (error) {
                alert('处理失败: ' + error.message);
            } finally {
                document.getElementById('loading').style.display = 'none';
            }
        }

        function clearAll() {
            document.getElementById('inputText').value = '';
            document.getElementById('resultText').textContent = '等待处理...';
            document.getElementById('entities').innerHTML = '';
            document.getElementById('stats').textContent = '';
        }
    </script>
</body>
</html>
"""

if __name__ == "__main__":
    print("Starting DeID Service...")
    print("Access at http://localhost:8088")
    uvicorn.run(app, host="0.0.0.0", port=8088)
