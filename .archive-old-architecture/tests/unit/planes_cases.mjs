import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

import { autoDetectPlanes, planeOf } from '../../src/planes.js';


const workspace = mkdtempSync(join(tmpdir(), 'emerald-planes-'));
const root = join(workspace, 'root');
const evil = join(workspace, 'root-evil');
mkdirSync(root);
mkdirSync(evil);
assert.equal(planeOf(join(evil, 'file.xlsx'), { specPlaneRoots: [root] }), 'data');
assert.equal(planeOf(root, { specPlaneRoots: [root] }), 'spec');

const docs = join(workspace, 'doc');
const nestedSpec = join(docs, 'spec');
mkdirSync(nestedSpec, { recursive: true });
const detected = autoDetectPlanes({ workspaceRoot: workspace });
assert(detected.documentRoots.includes(docs));
assert(detected.specRoots.includes(nestedSpec));

const deepSpec = join(docs, 'other', 'spec');
mkdirSync(deepSpec, { recursive: true });
assert(!autoDetectPlanes({ workspaceRoot: workspace }).specRoots.includes(deepSpec));

const metadata = join(workspace, 'metadata', 'table.xlsx');
mkdirSync(join(workspace, 'metadata'));
writeFileSync(metadata, 'fixture');
assert.equal(planeOf(metadata, { workspaceRoot: workspace }), 'data');

const data = join(workspace, 'data', 'table.xlsx');
mkdirSync(join(workspace, 'data'));
writeFileSync(data, 'fixture');
assert.equal(planeOf(data, { workspaceRoot: workspace }), 'data');

const sasData = join(workspace, 'doc', 'datasets', 'dm.xpt');
const sasCatalog = join(workspace, 'doc', 'datasets', 'formats.sas7bcat');
assert.equal(planeOf(sasData, { workspaceRoot: workspace }), 'data');
assert.equal(planeOf(sasCatalog, { workspaceRoot: workspace }), 'data');

const reportSupport = join(workspace, 'doc', 'Page_Details.xlsx');
const reportExport = join(workspace, 'doc', 'RT01_V1.0_29JUN2026_PROD.xls');
const reportCsv = join(workspace, 'doc', 'crViewer.csv');
assert.equal(planeOf(reportSupport, { workspaceRoot: workspace }), 'document');
assert.equal(planeOf(reportExport, { workspaceRoot: workspace }), 'document');
assert.equal(planeOf(reportCsv, { workspaceRoot: workspace }), 'document');

const ordinaryDocument = join(workspace, 'doc', 'notes.txt');
assert.equal(planeOf(ordinaryDocument, { workspaceRoot: workspace }), 'document');

const nestedDocument = join(workspace, 'project', 'doc', 'listing.xlsx');
const nestedSpecification = join(workspace, 'project', 'doc', 'spec', 'listing.xlsx');
assert.equal(planeOf(nestedDocument, { workspaceRoot: workspace }), 'document');
assert.equal(planeOf(nestedSpecification, { workspaceRoot: workspace }), 'spec');

const specificationDir = join(workspace, 'doc', 'spec');
const alsDir = join(workspace, 'doc', 'als');
const templateDir = join(workspace, 'doc', 'template');
mkdirSync(specificationDir, { recursive: true });
mkdirSync(alsDir, { recursive: true });
mkdirSync(templateDir, { recursive: true });
const specification = join(specificationDir, 'listing_spec.xlsx');
const als = join(alsDir, 'annotated_crf.xlsx');
const template = join(templateDir, 'listing.py');
assert.equal(planeOf(specification, { workspaceRoot: workspace }), 'spec');
assert.equal(planeOf(als, { workspaceRoot: workspace }), 'spec');
assert.equal(planeOf(template, { workspaceRoot: workspace }), 'spec');

const explicit = join(workspace, 'controlled');
mkdirSync(explicit);
assert.deepEqual(
  autoDetectPlanes({ workspaceRoot: workspace, specPlaneRoots: [explicit] }),
  { specRoots: [explicit], documentRoots: [] },
);

// 2026-08-24: listing 交付物跟随用户所选项目；未配置 outputPlaneRoot 时按
// .clinical-listing/output 标记目录识别为产物域（模型仅见收据/表头），
// 且该判定先于 .xlsx 扩展名兜底，否则交付 Excel 会被误判为数据域。
const projectDeliverable = join(workspace, 'project', '.clinical-listing', 'output', 'rbqm', 'RBQM_LISTINGS.xlsx');
assert.equal(planeOf(projectDeliverable, { workspaceRoot: workspace }), 'output');

const declaredPlaneRoot = join(workspace, 'deliverables');
mkdirSync(declaredPlaneRoot);
assert.equal(
  planeOf(join(declaredPlaneRoot, 'RBQM_LISTINGS.xlsx'), {
    workspaceRoot: workspace, outputPlaneRoot: declaredPlaneRoot,
  }),
  'output',
);

// staging 等非交付子目录不得误判为产物域
const stagingResidue = join(workspace, 'project', '.clinical-listing', 'staging', 'x.xlsx');
assert.notEqual(planeOf(stagingResidue, { workspaceRoot: workspace }), 'output');

console.log('planes_cases: PASS');
