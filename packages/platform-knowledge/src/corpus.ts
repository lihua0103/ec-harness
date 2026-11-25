/** 文档语料分片（KA10）：markdown → 引用可定位的知识块。纯函数，无存储依赖。
 *  分片以 ATX 标题为界；引用携带 doc_path 与行号，检索结果是引用不是正文替代。 */
import { createHash } from 'node:crypto';

export interface DocChunk {
  /** 标题文本（不含 # 前缀）。 */
  heading: string;
  /** 从文档根到本节的标题路径。 */
  headingPath: string[];
  level: number;
  /** 1 起含首尾的行号区间。 */
  lineStart: number;
  lineEnd: number;
  /** 含标题行在内的分片正文。 */
  body: string;
}

export interface CorpusChunk extends DocChunk {
  locale: 'zh' | 'en';
}

export interface CorpusDocument {
  docPath: string;
  docDigest: string;
  chunks: CorpusChunk[];
}

const HEADING = /^(#{1,6})\s+(.*)$/;

/** CJK 字符占比 ≥0.3 判为 zh；粗判但如实存储，供显示与过滤，不当权威语言标注。 */
export function detectLocale(text: string): 'zh' | 'en' {
  const cjk = text.match(/[　-鿿豈-﫿＀-￯]/g)?.length ?? 0;
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  return letters > 0 && cjk / letters >= 0.3 ? 'zh' : 'en';
}

export function chunkMarkdown(text: string): DocChunk[] {
  const lines = text.split(/\r\n|\r|\n/);
  const chunks: DocChunk[] = [];
  const stack: Array<{ level: number; heading: string }> = [];
  let current: { heading: string; path: string[]; level: number; lineStart: number } | null = null;
  let bodyLines: string[] = [];
  const flush = (lineEnd: number) => {
    if (current) {
      const body = bodyLines.join('\n');
      if (body.trim())
        chunks.push({
          heading: current.heading,
          headingPath: current.path,
          level: current.level,
          lineStart: current.lineStart,
          lineEnd,
          body,
        });
    }
    current = null;
    bodyLines = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const match = HEADING.exec(line);
    if (match) {
      // 每个标题独立成块，行号引用可定位到节。
      flush(index);
      const level = match[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, heading: match[2].trim() });
      current = { heading: match[2].trim(), path: stack.map((entry) => entry.heading), level, lineStart: index + 1 };
      bodyLines = [line];
    } else if (current) {
      bodyLines.push(line);
    } else {
      // 首个标题前的序言不成分片：无标题定位的正文不具备可引用结构。
    }
  }
  flush(lines.length);
  return chunks;
}

/** 文件 → 语料文档：digest 绑定全文，分片带 locale。 */
export function documentEntry(docPath: string, text: string): CorpusDocument {
  return {
    docPath,
    docDigest: createHash('sha256').update(text, 'utf8').digest('hex'),
    chunks: chunkMarkdown(text).map((chunk) => ({ ...chunk, locale: detectLocale(chunk.body) })),
  };
}
