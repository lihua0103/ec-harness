// Pre-flight: confirm the downloaded public protocol has a usable text layer.
import { readProtocol } from '../../src/protocol.js';
const dir = 'D:/project/company/ec-clinical-dsh/.runtime/dvp-e2e';
const r = readProtocol(dir, 'protocol.pdf', { startPage: 1, endPage: 3 });
console.log(JSON.stringify({
  file: r.file, sha256: r.sha256.slice(0, 12), pages: r.pages, skipped: r.skippedPages,
  stats: r.stats, notices: r.notices, diagnostics: r.diagnostics,
}, null, 1));
console.log('--- page1 head ---');
console.log(r.pages[0]?.text.slice(0, 400));
console.log('--- page3 head ---');
console.log(r.pages[2]?.text.slice(0, 300));
