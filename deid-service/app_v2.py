"""
DeID Service v2 - 纯规则引擎版本（无需 AI 推理）
针对临床文档脱敏优化
"""
import re
import time
from pathlib import Path
from typing import List, Dict, Optional
from dataclasses import dataclass, asdict

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel
import uvicorn

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

# ============ 规则引擎核心 ============
class DeidEngine:
    def __init__(self):
        self.entity_counter = {}

        # 申办方/公司名规则
        self.sponsor_patterns = [
            r"(?:申办方|赞助方|sponsor|发起方|申请方)[:：]\s*([^\n，,。；;]{2,40})",
            r"([A-Za-z一-龥]{2,30}(?:制药|生物|医药|药业|医疗|科技|生物科技|生命科学|生物技术|有限公司|股份有限公司|集团|控股|股份|有限))",
            r"([A-Za-z][A-Za-z\s]{2,30}(?:Pharma|Biotech|Bio|Pharmaceutical|Laboratories|Labs|Institute|Foundation|Corp|Inc|Ltd|LLC|Co)\.?[A-Za-z\s]*)",
            r"(?:由|由\s*)([^\n，,。；;]{2,30}(?:制药|生物|医药|药业|医疗|科技|有限公司|集团))\s*(?:申办|发起|资助|支持)",
        ]

        # 项目名称规则
        self.project_patterns = [
            r"(?:项目名称|项目名|project(?:\s+name)?|研究名称|试验名称|方案名称)[:：]\s*([^\n，,。；;]{2,50})",
            r"\b([A-Z][A-Za-z0-9\-]{3,30}(?:-[A-Z0-9]+)*)\b(?=\s*(?:研究|试验|项目|study|trial|protocol))",
            r"(?:方案编号|方案号|研究编号|试验编号)[:：]\s*([A-Z0-9\-]{5,30})",
            r"\(([A-Z]{2,5}[\-\s]?\d{2,5}[A-Z]?)\)",
        ]

        # 人名规则
        self.person_patterns = [
            r"(?:负责人|主要研究者|PI|研究者|作者|联系人|申请人)[:：]\s*([A-Za-z一-龥]{2,20})",
            r"([A-Za-z一-龥]{2,4})\s*(?:博士|教授|医生|研究员|主任医师|副主任医师|主任|教授|副教授|讲师|医师|药师|护士)",
            r"(?:Dr\.?|Professor|Prof\.?)\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)",
            r"\b([A-Z][a-z]+\s+[A-Z][a-z]+)\b(?=\s*(?:MD|PhD|Dr|Professor))",
        ]

        # 地址/机构规则
        self.address_patterns = [
            r"(?:地址|单位|机构|医院|研究中心|实验室)[:：]\s*([^\n，,。；;]{5,60})",
            r"([一-龥]{2,20}(?:省|市|区|县|镇|乡|村)[^\n，,。；;]{2,50}(?:医院|中心|大学|研究所|研究院|公司|集团|大厦|大楼|园区))",
            r"(\d+[^\n，,。；;]{2,50}(?:路|街|巷|道|号|弄|室))",
        ]

        # 日期规则
        self.date_patterns = [
            r"\d{4}[\-/年]\d{1,2}[\-/月]\d{1,2}日?",
            r"\d{4}年\d{1,2}月\d{1,2}日",
            r"\d{1,2}月\d{1,2}日",
            r"(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}",
        ]

        # 编号/版本规则
        self.id_patterns = [
            r"(?:编号|编号|协议号|版本|方案编号|研究编号|伦理编号|批件号)[:：]\s*([A-Za-z0-9\-]{3,40})",
            r"\b[A-Z]{2,5}[\-\s]?\d{2,5}[A-Z]?\b",
            r"\b\d{4}[\-\/]\d{4,6}\b",
            r"Version\s*\d+(\.\d+)*",
        ]

        # 编译所有正则
        self.compiled_patterns = {
            "SPONSOR": [re.compile(p, re.IGNORECASE | re.UNICODE) for p in self.sponsor_patterns],
            "PROJECT": [re.compile(p, re.IGNORECASE | re.UNICODE) for p in self.project_patterns],
            "PERSON": [re.compile(p, re.IGNORECASE | re.UNICODE) for p in self.person_patterns],
            "ADDRESS": [re.compile(p, re.IGNORECASE | re.UNICODE) for p in self.address_patterns],
            "DATE": [re.compile(p, re.IGNORECASE | re.UNICODE) for p in self.date_patterns],
            "ID": [re.compile(p, re.IGNORECASE | re.UNICODE) for p in self.id_patterns],
        }

    def extract(self, text: str) -> List[Dict]:
        """提取所有敏感实体"""
        entities = []

        for etype, patterns in self.compiled_patterns.items():
            for pattern in patterns:
                for match in pattern.finditer(text):
                    # 确定提取哪个组
                    entity_text = match.group(1) if match.groups() else match.group(0)
                    entity_text = entity_text.strip()
                    if not entity_text:
                        continue
                    entities.append({
                        "text": entity_text,
                        "type": etype,
                        "start": match.start(),
                        "end": match.end(),
                        "confidence": 0.9 if match.groups() else 0.75,
                        "matched_pattern": pattern.pattern[:50],
                    })

        # 去重：保留更具体/置信度高的
        seen = set()
        unique_entities = []
        for e in sorted(entities, key=lambda x: (-x["confidence"], -len(x["text"]))):
            key = (e["text"], e["type"])
            if key not in seen:
                seen.add(key)
                unique_entities.append(e)

        return unique_entities

    def replace(self, text: str, entities: List[Dict]) -> tuple:
        """替换实体为占位符"""
        # 按位置倒序替换，避免偏移
        sorted_entities = sorted(entities, key=lambda x: -x["start"])
        result = text
        self.entity_counter = {}

        for e in sorted_entities:
            if e["type"] not in self.entity_counter:
                self.entity_counter[e["type"]] = 0
            self.entity_counter[e["type"]] += 1
            placeholder = f"[{e['type']}_{self.entity_counter[e['type']]}]"
            e["replaced"] = placeholder
            result = result[:e["start"]] + placeholder + result[e["end"] + len(e["text"]) - (e["end"] - e["start"]):]

        return result, self.entity_counter.copy()

# ============ FastAPI 应用 ============
app = FastAPI(title="DeID Service v2", description="本地文档脱敏服务（纯规则引擎）")

engine = DeidEngine()

class TextRequest(BaseModel):
    text: str

@app.get("/", response_class=HTMLResponse)
async def index():
    return HTMLResponse(content=HTML_PAGE)

@app.post("/api/deid")
async def deid_text(request: TextRequest):
    if not request.text.strip():
        raise HTTPException(status_code=400, detail="文本不能为空")

    start_time = time.time()
    entities = engine.extract(request.text)
    deidentified, counts = engine.replace(request.text, entities)
    elapsed = time.time() - start_time

    return JSONResponse(content={
        "deidentified": deidentified,
        "entities": entities,
        "processing_time": round(elapsed, 3),
        "stats": counts,
        "total_entities": len(entities),
    })

@app.post("/api/deid-file")
async def deid_file(file: UploadFile = File(...)):
    content = await file.read()
    text = content.decode("utf-8", errors="replace")

    start_time = time.time()
    entities = engine.extract(text)
    deidentified, counts = engine.replace(text, entities)
    elapsed = time.time() - start_time

    return JSONResponse(content={
        "filename": file.filename,
        "deidentified": deidentified,
        "entities": entities,
        "processing_time": round(elapsed, 3),
        "stats": counts,
        "total_entities": len(entities),
    })

@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "2.0", "engine": "rule-based"}

# ============ HTML 页面 ============
HTML_PAGE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>本地文档脱敏服务 v2</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background: #f5f5f5;
            padding: 20px;
        }
        .container { max-width: 1400px; margin: 0 auto; }
        h1 { text-align: center; color: #333; margin-bottom: 10px; }
        .subtitle { text-align: center; color: #666; margin-bottom: 20px; font-size: 14px; }
        .card {
            background: white;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .input-area {
            width: 100%;
            min-height: 300px;
            padding: 12px;
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 14px;
            resize: vertical;
            font-family: inherit;
        }
        .btn {
            background: #007bff;
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            margin-right: 10px;
            font-weight: 500;
        }
        .btn:hover { background: #0056b3; }
        .btn:disabled { background: #ccc; cursor: not-allowed; }
        .btn-secondary { background: #6c757d; }
        .btn-secondary:hover { background: #545b62; }
        .btn-success { background: #28a745; }
        .btn-success:hover { background: #1e7e34; }
        .result-area {
            width: 100%;
            min-height: 300px;
            padding: 12px;
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 14px;
            background: #f8f9fa;
            white-space: pre-wrap;
            word-break: break-all;
        }
        .entities {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-top: 10px;
        }
        .entity-tag {
            background: #e7f3ff;
            border: 1px solid #b3d7ff;
            border-radius: 4px;
            padding: 4px 8px;
            font-size: 12px;
            display: inline-flex;
            align-items: center;
            gap: 4px;
        }
        .entity-tag .type {
            color: #0056b3;
            font-weight: bold;
            background: #d1e7ff;
            padding: 1px 4px;
            border-radius: 2px;
            font-size: 11px;
        }
        .entity-tag.sponsor { background: #fff3cd; border-color: #ffc107; }
        .entity-tag.sponsor .type { background: #ffeaa7; color: #856404; }
        .entity-tag.project { background: #d1ecf1; border-color: #17a2b8; }
        .entity-tag.project .type { background: #b8daff; color: #004085; }
        .entity-tag.person { background: #f8d7da; border-color: #dc3545; }
        .entity-tag.person .type { background: #f5c6cb; color: #721c24; }
        .entity-tag.address { background: #d4edda; border-color: #28a745; }
        .entity-tag.address .type { background: #c3e6cb; color: #155724; }
        .entity-tag.date { background: #e2e3e5; border-color: #6c757d; }
        .entity-tag.date .type { background: #d6d8db; color: #383d41; }
        .entity-tag.id { background: #f8d7da; border-color: #dc3545; }
        .entity-tag.id .type { background: #f5c6cb; color: #721c24; }
        .stats {
            color: #666;
            font-size: 13px;
            margin-top: 10px;
            padding: 10px;
            background: #f8f9fa;
            border-radius: 4px;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 10px;
            margin-top: 10px;
        }
        .stat-item {
            text-align: center;
            padding: 8px;
            background: white;
            border-radius: 4px;
            border: 1px solid #e0e0e0;
        }
        .stat-item .count { font-size: 20px; font-weight: bold; color: #007bff; }
        .stat-item .label { font-size: 11px; color: #666; }
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
            transition: border-color 0.3s;
        }
        .file-upload:hover, .file-upload.dragover {
            border-color: #007bff;
            background: #f0f8ff;
        }
        .file-upload input { display: none; }
        .file-info {
            color: #666;
            font-size: 13px;
            margin-top: 10px;
        }
        .loading {
            display: none;
            text-align: center;
            padding: 20px;
        }
        .loading.show { display: block; }
        .version-badge {
            display: inline-block;
            background: #28a745;
            color: white;
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 11px;
            margin-left: 10px;
            vertical-align: middle;
        }
        .scroll-btn {
            position: fixed;
            bottom: 20px;
            right: 20px;
            width: 50px;
            height: 50px;
            border-radius: 50%;
            background: #007bff;
            color: white;
            border: none;
            cursor: pointer;
            font-size: 20px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.2);
            display: none;
        }
        .scroll-btn.show { display: block; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔒 本地文档脱敏服务 <span class="version-badge">v2.0 规则引擎</span></h1>
        <p class="subtitle">无需 AI 推理 · 毫秒级处理 · 支持批量上传</p>

        <div class="card">
            <h3>📁 上传文件</h3>
            <div class="file-upload" id="fileDropZone" onclick="document.getElementById('fileInput').click()">
                <p>📄 点击或拖拽文件到此处上传</p>
                <p class="file-info">支持格式: TXT, MD, CSV, JSON (自动识别敏感信息)</p>
                <input type="file" id="fileInput" accept=".txt,.md,.csv,.json" onchange="handleFileUpload(this)">
            </div>
            <div id="fileInfo" class="file-info"></div>
        </div>

        <div class="two-col">
            <div class="card">
                <h3>📝 原文输入</h3>
                <textarea id="inputText" class="input-area" placeholder="在此粘贴需要脱敏的文档内容...

示例：
申办方：北京XX制药有限公司
项目名称：EMPA-KIDNEY 多中心临床试验
负责人：张医生
日期：2024年3月15日
编号：ABC-2024-001

支持自动识别：公司名、项目名、人名、地址、日期、编号等"></textarea>
                <div style="margin-top: 10px;">
                    <button class="btn btn-success" onclick="processText()" id="processBtn">🚀 开始脱敏</button>
                    <button class="btn btn-secondary" onclick="clearAll()">🗑️ 清空</button>
                    <button class="btn btn-secondary" onclick="loadSample()">📋 加载示例</button>
                </div>
            </div>

            <div class="card">
                <h3>✅ 脱敏结果</h3>
                <div id="resultText" class="result-area">等待处理...</div>
                <div id="stats" class="stats" style="display: none;"></div>
                <div id="entities" class="entities"></div>
            </div>
        </div>

        <div id="loading" class="loading">
            <p>⏳ 正在处理中...</p>
        </div>
    </div>

    <button class="scroll-btn" id="scrollTop" onclick="window.scrollTo({top:0,behavior:'smooth'})">↑</button>

    <script>
        // 拖拽上传
        const dropZone = document.getElementById('fileDropZone');
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('dragover');
        });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
            const file = e.dataTransfer.files[0];
            if (file) handleFile(file);
        });

        async function processText() {
            const text = document.getElementById('inputText').value;
            if (!text.trim()) {
                alert('请输入需要脱敏的文本');
                return;
            }

            document.getElementById('loading').classList.add('show');
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
                displayResult(result);

            } catch (error) {
                alert('处理失败: ' + error.message);
            } finally {
                document.getElementById('loading').classList.remove('show');
                document.getElementById('processBtn').disabled = false;
            }
        }

        async function handleFileUpload(input) {
            const file = input.files[0];
            if (file) handleFile(file);
        }

        async function handleFile(file) {
            document.getElementById('fileInfo').textContent = `📄 已选择文件: ${file.name} (${(file.size/1024).toFixed(1)} KB)`;
            document.getElementById('loading').classList.add('show');

            const formData = new FormData();
            formData.append('file', file);

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
                displayResult(result);
                document.getElementById('fileInfo').textContent = `✅ 已处理文件: ${result.filename}`;

            } catch (error) {
                alert('处理失败: ' + error.message);
            } finally {
                document.getElementById('loading').classList.remove('show');
            }
        }

        function displayResult(result) {
            document.getElementById('resultText').textContent = result.deidentified;

            // 统计信息
            const statsDiv = document.getElementById('stats');
            statsDiv.style.display = 'block';
            let statsHtml = `
                <strong>📊 处理统计</strong>
                <div class="stats-grid">
                    <div class="stat-item"><div class="count">${result.total_entities}</div><div class="label">总实体数</div></div>
                    <div class="stat-item"><div class="count">${result.processing_time}s</div><div class="label">处理耗时</div></div>
            `;
            for (const [type, count] of Object.entries(result.stats)) {
                const typeLabel = {SPONSOR:'申办方',PROJECT:'项目',PERSON:'人名',ADDRESS:'地址',DATE:'日期',ID:'编号'}[type] || type;
                statsHtml += `<div class="stat-item"><div class="count">${count}</div><div class="label">${typeLabel}</div></div>`;
            }
            statsHtml += '</div>';
            statsDiv.innerHTML = statsHtml;

            // 实体列表
            const entitiesDiv = document.getElementById('entities');
            entitiesDiv.innerHTML = result.entities.map(e => `
                <div class="entity-tag ${e.type.toLowerCase()}">
                    <span class="type">${e.type}</span>
                    <span>${e.text}</span>
                </div>
            `).join('');
        }

        function clearAll() {
            document.getElementById('inputText').value = '';
            document.getElementById('resultText').textContent = '等待处理...';
            document.getElementById('entities').innerHTML = '';
            document.getElementById('stats').style.display = 'none';
            document.getElementById('fileInfo').textContent = '';
        }

        function loadSample() {
            document.getElementById('inputText').value = `申办方：北京XX制药有限公司
项目名称：EMPA-KIDNEY 多中心临床试验
方案编号：ABC-2024-001
负责人：张医生
主要研究者：李教授
研究中心：北京协和医院
日期：2024年3月15日
版本：Version 2.0

研究背景：
本研究由上海XX生物科技有限公司资助，旨在评估新药对糖尿病肾病患者的疗效。
研究将在全国20家研究中心开展，预计入组患者300例。
研究负责人：王主任
联系邮箱：contact@example.com
联系电话：010-12345678`;
        }

        // 滚动按钮
        window.addEventListener('scroll', () => {
            document.getElementById('scrollTop').classList.toggle('show', window.scrollY > 300);
        });
    </script>
</body>
</html>
"""

if __name__ == "__main__":
    print("=" * 60)
    print("🚀 DeID Service v2.0 (规则引擎版本)")
    print("=" * 60)
    print("✅ 无需 AI 推理，毫秒级处理")
    print("🌐 访问地址: http://localhost:8088")
    print("📄 支持格式: TXT, MD, CSV, JSON")
    print("=" * 60)
    uvicorn.run(app, host="0.0.0.0", port=8088)