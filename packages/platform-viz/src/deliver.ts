/**
 * 交付封存：配置快照、渲染页、验收记录一起落盘，并给出逐文件摘要。
 * 验收不通过也照常封存，result 记录为 fail，便于定位；不静默丢弃失败证据。
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { acceptPage, type AcceptanceRecord, type PairResult } from './accept.js';
import { buildModel, renderHtml } from './render.js';
import { pageDigest, stableStringify, type Bundle } from './spec.js';

export interface DeliveryFile {
  name: string;
  sha256: string;
  bytes: number;
}

export interface DeliveryManifest {
  pageId: string;
  createdAt: string;
  specDigest: string;
  result: 'pass' | 'fail';
  files: DeliveryFile[];
  note: string;
}

export interface DeliveryContent {
  files: Array<{ name: string; content: Buffer }>;
  acceptance: AcceptanceRecord;
  digest: string;
}

export function deliveryContent(bundle: Bundle, pairs: PairResult[] = []): DeliveryContent {
  const acceptance = acceptPage(bundle, pairs);
  return {
    digest: pageDigest(bundle),
    acceptance,
    files: [
      { name: 'snapshot.json', content: Buffer.from(stableStringify(bundle), 'utf8') },
      { name: 'page.html', content: Buffer.from(renderHtml(buildModel(bundle)), 'utf8') },
      { name: 'acceptance.json', content: Buffer.from(JSON.stringify(acceptance, null, 2), 'utf8') },
    ],
  };
}

export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function sealDelivery(
  root: string,
  bundle: Bundle,
  pairs: PairResult[] = [],
  createdAt = new Date().toISOString(),
): Promise<{ directory: string; manifestPath: string; manifest: DeliveryManifest }> {
  const content = deliveryContent(bundle, pairs);
  const directory = resolve(root, 'deliveries', `${bundle.layout.pageId}-${content.digest.slice(0, 8)}`);
  await mkdir(directory, { recursive: true });
  for (const file of content.files) await writeFile(resolve(directory, file.name), file.content);
  const manifest: DeliveryManifest = {
    pageId: bundle.layout.pageId,
    createdAt,
    specDigest: content.digest,
    result: content.acceptance.result,
    files: content.files.map((file) => ({
      name: file.name,
      sha256: sha256(file.content),
      bytes: file.content.length,
    })),
    note: '配置快照、渲染页与验收记录一并封存；result=fail 时同样保留，便于定位。',
  };
  const manifestPath = resolve(directory, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return { directory, manifestPath, manifest };
}
