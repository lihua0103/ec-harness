"""
临床数据 Tokenizer - 用于敏感数据检测
"""
import re
from typing import List, Tuple

# 临床日期格式
CLINICAL_DATE_PATTERNS = [
    r'\b\d{2}-[A-Z]{3}-\d{4}\b',  # DD-MMM-YYYY
    r'\b\d{2}/[A-Z]{3}/\d{4}\b',  # DD/MMM/YYYY
    r'\b\d{4}-\d{2}-\d{2}\b',     # YYYY-MM-DD
    r'\b\d{2}/\d{2}/\d{4}\b',     # DD/MM/YYYY
]

# 受试者 ID 模式
SUBJECT_ID_PATTERNS = [
    r'\b[A-Z0-9]{3,}-\d{3,}\b',   # SITE-SUBJ
    r'\bSUBJ-?\d{3,}\b',          # SUBJ-001
    r'\b\d{4,6}\b',               # 4-6 位数字
]

def tokenize_clinical_text(text: str) -> List[Tuple[str, str]]:
    """
    将临床文本分词并标注类型
    
    返回: [(token, type), ...]
    """
    tokens = []
    
    # 检测日期
    for pattern in CLINICAL_DATE_PATTERNS:
        for match in re.finditer(pattern, text, re.IGNORECASE):
            tokens.append((match.group(), 'DATE'))
    
    # 检测受试者 ID
    for pattern in SUBJECT_ID_PATTERNS:
        for match in re.finditer(pattern, text):
            tokens.append((match.group(), 'SUBJECT_ID'))
    
    return tokens

def contains_sensitive_data(text: str) -> bool:
    """检查文本是否包含敏感数据"""
    tokens = tokenize_clinical_text(text)
    return len(tokens) > 0
