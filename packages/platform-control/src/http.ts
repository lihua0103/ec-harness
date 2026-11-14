/** Local workbench HTTP API over the platform control service.
 *
 *  This is the browser-facing seam: a trusted authenticator derives the Principal, the service
 *  re-authorizes every read/write, and projections never include raw run input, credentials or
 *  worker paths. It is not an enterprise gateway; production deployments replace the dev
 *  authenticator and put this behind their identity-aware proxy/BFF.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { PlatformControlService } from './service.js';
import { PlatformError } from './registry.js';
import { AuthorizationError, type Principal } from './policy.js';
import { RunError } from '../../platform-runtime/src/run.js';
import { publicCatalog } from './models.js';
import type { AppRecord, ArtifactRecord, InputCommit, RunRecord, WorkRecord } from './store.js';

export type Authenticator = (req: IncomingMessage) => Principal | Promise<Principal>;

export interface WorkbenchApiOptions {
  service: PlatformControlService;
  authenticate: Authenticator;
  /** Static workbench assets served on the same origin; API-only when omitted. */
  appDir?: string;
  /** Display context included in the bootstrap payload. */
  workspace?: { name: string; note?: string };
  configuration?: {
    mode: string;
    worker: { configured: boolean; profile?: string; workspace?: string };
    instructions: string[];
  };
}

const MAX_BODY = 1024 * 1024;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

export const publicApp = (app: AppRecord) => ({
  appId: app.appId,
  appVersion: app.appVersion,
  state: app.state,
  descriptor: app.draft.descriptor,
  requiredCapabilities: app.draft.requiredCapabilities,
  runtimeBundleDigest: app.draft.runtimeBundleDigest,
  planDigest: app.plan.planDigest,
  releaseDigest: app.releaseDigest,
  createdAt: app.createdAt,
  ...(app.revokedAt ? { revokedAt: app.revokedAt } : {}),
});
export const publicRun = (record: RunRecord) => {
  // Run input and prior-work context are exposed only through their authorized scoped views.
  const { input: _input, context: _context, ...rest } = record;
  return rest;
};
/** Input content belongs to this authorized Work; a digest is not a usable conversation. */
export const publicInput = (commit: InputCommit) => commit;
export const publicWork = (work: WorkRecord) => work;
/** Artifact projections never expose the control-plane seal path. */
export const publicArtifact = (artifact: ArtifactRecord) => {
  const { sealedPath: _sealedPath, ...rest } = artifact;
  return rest;
};

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
};

const errorStatus = (error: unknown): number => {
  if (error instanceof AuthorizationError) return 403;
  if (error instanceof PlatformError) {
    if (/_NOT_FOUND$|_NOT_BOUND$/.test(error.code)) return 404;
    if (/_ACCESS_DENIED$|_AUTHORIZATION_DENIED$/.test(error.code)) return 403;
    if (/_TOO_LARGE$/.test(error.code)) return 413;
    if (/_EXISTS$|_ARCHIVED$|_TERMINAL$|_NOT_ACTIVE$|_REVISION_STALE$|_CANCEL_/.test(error.code)) return 409;
    if (/_INVALID$|_UNKNOWN$|_REQUIRED$|_UNAVAILABLE$|_MISMATCH$|_OPTION_|_CHANGED$/.test(error.code)) return 400;
    return 409;
  }
  if (error instanceof RunError) return 409;
  return 500;
};
const errorBody = (error: unknown): { ok: false; code: string; detail: string } => {
  if (error instanceof PlatformError || error instanceof AuthorizationError || error instanceof RunError) {
    return { ok: false, code: error.code, detail: error.message };
  }
  return { ok: false, code: 'PLATFORM_OPERATION_FAILED', detail: '操作未完成；控制面未返回可公开的错误正文。' };
};

const readBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new PlatformError('REQUEST_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) {
        resolveBody(undefined);
        return;
      }
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new PlatformError('REQUEST_JSON_INVALID'));
      }
    });
    req.on('error', reject);
  });

const page = (value: string | null, fallback: number, max: number): number => {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) throw new PlatformError('PAGE_INVALID');
  return parsed;
};

const objectBody = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PlatformError('REQUEST_JSON_INVALID');
  return value as Record<string, unknown>;
};

/** Serve only whitelisted assets inside appDir; never the repository or arbitrary files. */
async function serveAsset(appDir: string, pathname: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return false;
  const file = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  if (!/^[A-Za-z0-9._/-]+$/.test(file) || file.split('/').includes('..')) return false;
  const target = resolve(appDir, file);
  const rootReal = await realpath(appDir);
  let real: string;
  try {
    const info = await stat(target);
    if (!info.isFile()) return false;
    real = await realpath(target);
  } catch {
    return false;
  }
  const relativePath = relative(rootReal, real);
  if (relativePath.startsWith('..') || relativePath.includes(`..${sep}`) || isAbsolute(relativePath)) return false;
  const type = MIME[extname(real).toLowerCase()];
  if (!type) return false;
  const body = await readFile(real);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

const execFileAsync = promisify(execFile);

/** Open the local machine's native folder dialog. Only a user-chosen absolute path is returned. */
async function pickLocalDirectory(): Promise<string | null> {
  if (process.platform !== 'win32') {
    throw new PlatformError('FS_PICKER_UNAVAILABLE', '当前系统没有内置目录选择；请在桌面端选择或使用受管部署。');
  }
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$f.Description = '选择工作目录'",
    "if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.SelectedPath) }",
  ].join('; ');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
    timeout: 180_000,
    windowsHide: true,
  });
  const selected = stdout.trim();
  return selected || null;
}

export function createWorkbenchServer(options: WorkbenchApiOptions): Server {
  const { service, authenticate, appDir, workspace } = options;

  const handleApi = async (req: IncomingMessage, res: ServerResponse, url: URL, principal: Principal) => {
    const segments = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const method = req.method ?? 'GET';
    const offset = () => page(url.searchParams.get('offset'), 0, 1_000_000);
    const limit = (fallback = 20) => page(url.searchParams.get('limit'), fallback, 100);

    if (segments[1] === 'health' && method === 'GET') {
      json(res, 200, { ok: true });
      return;
    }
    if (segments[1] === 'workbench' && method === 'GET') {
      const works = service.listWorks(undefined, 0, 50, principal);
      const runs = service.listRuns(undefined, 0, 50, principal);
      json(res, 200, {
        projects: service.listProjects(principal),
        apps: service.listApps(undefined, principal).map(publicApp),
        works: { total: works.total, items: works.items.map(publicWork) },
        runs: { total: runs.total, items: runs.items.map(publicRun) },
        pending: service.pendingInteractions(principal),
        models: {
          catalog: publicCatalog(service.modelCatalog(principal)),
          preference: service.modelPreference(principal),
        },
        status: service.status(),
        ...(options.configuration ? { configuration: options.configuration } : {}),
        ...(workspace ? { workspace } : {}),
      });
      return;
    }
    if (segments[1] === 'models') {
      if (segments.length === 2 && method === 'GET') {
        json(res, 200, {
          catalog: publicCatalog(service.modelCatalog(principal)),
          preference: service.modelPreference(principal),
        });
        return;
      }
      if (segments.length === 3 && segments[2] === 'preference' && method === 'PUT') {
        const body = objectBody(await readBody(req));
        if (typeof body.selectionId !== 'string') throw new PlatformError('MODEL_SELECTION_UNKNOWN');
        json(res, 200, service.setModelPreference(body.selectionId, principal));
        return;
      }
    }
    if (segments[1] === 'apps') {
      if (segments.length === 4 && segments[3] === 'models' && method === 'GET') {
        json(res, 200, service.availableModels(segments[2], url.searchParams.get('version') ?? '', principal));
        return;
      }
      if (segments.length === 2 && method === 'GET') {
        json(res, 200, { items: service.listApps(undefined, principal).map(publicApp) });
        return;
      }
      if (segments.length === 4 && method === 'GET') {
        json(res, 200, publicApp(service.getApp(segments[2], segments[3], principal)));
        return;
      }
    }
    if (segments[1] === 'fs' && segments.length === 3 && segments[2] === 'pick' && method === 'POST') {
      service.authorizePick(principal);
      json(res, 200, { path: await pickLocalDirectory() });
      return;
    }
    if (segments[1] === 'projects') {
      if (segments.length === 2 && method === 'GET') {
        json(res, 200, { items: service.listProjects(principal) });
        return;
      }
      if (segments.length === 2 && method === 'POST') {
        const body = objectBody(await readBody(req));
        json(res, 201, service.createProject({ name: body.name as string, code: body.code as string | undefined }, principal));
        return;
      }
      if (segments.length === 4 && segments[3] === 'workspaces') {
        if (method === 'GET') {
          json(res, 200, { items: service.projectWorkspaces(segments[2], principal) });
          return;
        }
        if (method === 'POST') {
          const body = objectBody(await readBody(req));
          json(res, 201, await service.createWorkspace({
            projectId: segments[2], name: body.name as string, directory: body.directory as string,
            ...(body.outputDirectory !== undefined ? { outputDirectory: body.outputDirectory as string } : {}),
          }, principal));
          return;
        }
      }
    }
    if (segments[1] === 'works') {
      if (segments.length === 2 && method === 'GET') {
        const state = url.searchParams.get('state') ?? undefined;
        json(res, 200, service.listWorks(state as 'ACTIVE' | 'ARCHIVED' | undefined, offset(), limit(), principal));
        return;
      }
      if (segments.length === 2 && method === 'POST') {
        const body = objectBody(await readBody(req));
        json(
          res,
          201,
          service.createWork(
            {
              projectId: body.projectId as string,
              appId: body.appId as string,
              appVersion: body.appVersion as string,
              title: body.title as string,
              ...(body.workspaceId !== undefined ? { workspaceId: body.workspaceId as string } : {}),
              ...(body.goal !== undefined ? { goal: body.goal as string } : {}),
            },
            principal,
          ),
        );
        return;
      }
      if (segments.length === 3 && method === 'GET') {
        json(res, 200, service.getWork(segments[2], principal));
        return;
      }
      if (segments.length === 4 && segments[3] === 'workspace' && method === 'PUT') {
        const body = objectBody(await readBody(req));
        if (typeof body.workspaceId !== 'string') throw new PlatformError('WORKSPACE_REQUIRED');
        json(res, 200, service.bindWorkWorkspace(segments[2], body.workspaceId, principal));
        return;
      }
      if (segments.length === 4 && segments[3] === 'conversation' && method === 'GET') {
        json(res, 200, service.workConversation(segments[2], principal));
        return;
      }
      if (segments.length === 4 && segments[3] === 'draft') {
        if (method === 'GET') {
          json(res, 200, service.workDraft(segments[2], principal));
          return;
        }
        if (method === 'PUT') {
          const body = objectBody(await readBody(req));
          json(res, 200, service.saveWorkDraft(segments[2], body.text, body.expectedRevision, principal));
          return;
        }
      }
      if (segments.length === 4 && segments[3] === 'archive' && method === 'POST') {
        json(res, 200, service.archiveWork(segments[2], principal));
        return;
      }
      if (segments.length === 4 && segments[3] === 'runs' && method === 'GET') {
        json(res, 200, service.runsForWork(segments[2], offset(), limit(), principal));
        return;
      }
      if (segments.length === 4 && segments[3] === 'runs' && method === 'POST') {
        const body = objectBody(await readBody(req));
        if (!('input' in body)) throw new PlatformError('REQUEST_JSON_INVALID', 'input');
        json(
          res,
          201,
          publicRun(
            service.createWorkRun(segments[2], body.input, principal, {
              ...(body.modelSelectionId !== undefined
                ? { modelSelectionId: body.modelSelectionId as string }
                : {}),
              ...(body.modelOptions !== undefined ? { modelOptions: body.modelOptions } : {}),
            }),
          ),
        );
        return;
      }
      if (segments.length === 4 && segments[3] === 'binding' && method === 'GET') {
        json(res, 200, { binding: service.workBinding(segments[2], principal) ?? null });
        return;
      }
      if (segments.length === 4 && segments[3] === 'context' && method === 'GET') {
        json(res, 200, service.resolveWorkContext(segments[2], principal, {
          ...(url.searchParams.get('sessionId') ? { sessionId: url.searchParams.get('sessionId') as string } : {}),
          ...(url.searchParams.get('domainId') ? { domainId: url.searchParams.get('domainId') as string } : {}),
        }));
        return;
      }
      if (segments.length === 4 && segments[3] === 'bindings') {
        if (method === 'GET') {
          json(res, 200, { items: service.workBindingHistory(segments[2], principal) });
          return;
        }
        if (method === 'POST') {
          const body = objectBody(await readBody(req));
          json(res, 201, service.bindWorkSession({
            workId: segments[2],
            domainId: body.domainId as string,
            sessionId: body.sessionId as string,
            releaseDigest: body.releaseDigest as string,
            ...(body.workspaceId !== undefined ? { workspaceId: body.workspaceId as string } : {}),
            ...(body.relation !== undefined ? { relation: body.relation as 'primary' | 'fork' | 'reopened' } : {}),
            ...(body.sourceWorkId !== undefined ? { sourceWorkId: body.sourceWorkId as string } : {}),
          }, principal));
          return;
        }
      }
      if (segments.length === 4 && segments[3] === 'submissions' && method === 'GET') {
        json(res, 200, { items: service.submissionsForWork(segments[2], principal) });
        return;
      }
      if (segments.length === 4 && segments[3] === 'input-baselines') {
        if (method === 'GET') {
          const result = service.inputBaselinesForWork(segments[2], offset(), limit(), principal);
          json(res, 200, { total: result.total, items: result.items });
          return;
        }
        if (method === 'POST') {
          const body = objectBody(await readBody(req));
          json(res, 201, service.appendInputBaseline(segments[2], {
            sourceRef: body.sourceRef as string,
            digest: body.digest as string,
          }, principal));
          return;
        }
      }
    }
    if (segments[1] === 'domains') {
      if (segments.length === 2 && method === 'GET') {
        json(res, 200, { items: service.listDomains(principal) });
        return;
      }
      if (segments.length === 2 && method === 'POST') {
        const body = objectBody(await readBody(req));
        json(res, 201, service.registerDomain({
          owner: (body.owner as string | undefined) ?? principal.orgId ?? ('owner:' + principal.actorId),
          kind: (body.kind as 'local' | 'hosted' | undefined) ?? 'local',
          ...(body.deploymentRef !== undefined ? { deploymentRef: body.deploymentRef as string } : {}),
          capabilities: Array.isArray(body.capabilities) ? body.capabilities as string[] : [],
        }, principal));
        return;
      }
      if (segments.length === 4 && segments[3] === 'state' && method === 'PUT') {
        const body = objectBody(await readBody(req));
        if (!Number.isSafeInteger(body.expectedRevision)) throw new PlatformError('DOMAIN_INVALID', 'expectedRevision');
        json(res, 200, service.setDomainState(
          segments[2], body.state as 'HEALTHY' | 'DEGRADED' | 'UNKNOWN', body.expectedRevision as number, principal,
        ));
        return;
      }
    }
    if (segments[1] === 'sessions') {
      if (segments.length === 3 && method === 'GET') {
        // Reverse lookup: the native shell knows only a sessionId; resolve its Work, or null.
        const resolved = service.workForSession(segments[2], principal);
        json(res, 200, {
          sessionId: segments[2],
          work: resolved?.work ?? null,
          binding: resolved?.binding ?? null,
        });
        return;
      }
    }
    if (segments[1] === 'submissions') {
      if (segments.length === 2 && method === 'POST') {
        const body = objectBody(await readBody(req));
        // The trusted submitter is the authenticated principal, never a body-supplied actor.
        json(res, 201, service.recordSubmission({
          workId: body.workId as string,
          domainId: body.domainId as string,
          sessionId: body.sessionId as string,
          requestId: body.requestId as string,
          submittedBy: principal.actorId,
          ...(principal.orgId !== undefined ? { orgId: principal.orgId } : {}),
          input: body.input,
        }, principal));
        return;
      }
      if (segments.length === 4 && method === 'POST') {
        const body = objectBody(await readBody(req));
        switch (segments[3]) {
          case 'acknowledge':
            json(res, 200, service.acknowledgeSubmission(segments[2], String(body.admission ?? ''), principal));
            return;
          case 'consume':
            json(res, 200, service.consumeSubmission(segments[2], principal));
            return;
          case 'unknown':
            json(res, 200, service.markSubmissionUnknown(segments[2], String(body.note ?? ''), principal));
            return;
          default:
            break;
        }
      }
    }
    if (segments[1] === 'interactions') {
      if (segments.length === 4 && segments[3] === 'answer' && method === 'POST') {
        const body = objectBody(await readBody(req));
        json(res, 200, service.answerInteraction(segments[2], body.answer, principal));
        return;
      }
    }
    if (segments[1] === 'runs') {
      if (segments.length === 2 && method === 'GET') {
        const appId = url.searchParams.get('appId') ?? undefined;
        const result = service.listRuns(appId, offset(), limit(), principal);
        json(res, 200, { total: result.total, items: result.items.map(publicRun) });
        return;
      }
      if (segments.length === 4 && segments[3] === 'reconcile' && method === 'POST') {
        json(res, 200, publicRun(service.reconcileUnknown(segments[2], principal)));
        return;
      }
      if (segments.length === 3 && method === 'GET') {
        json(res, 200, publicRun(service.getRun(segments[2], principal)));
        return;
      }
      if (segments.length === 5 && segments[3] === 'events' && segments[4] === 'stream' && method === 'GET') {
        const raw = req.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0';
        const after = Number(Array.isArray(raw) ? raw[0] : raw);
        if (!Number.isSafeInteger(after) || after < 0) throw new PlatformError('RUN_EVENT_CURSOR_INVALID');
        service.eventsAfter(segments[2], after, principal);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Content-Type-Options': 'nosniff',
        });
        res.flushHeaders();
        let cursor = after;
        let stopped = false;
        const stop = () => {
          if (stopped) return;
          stopped = true;
          clearInterval(pump);
          clearInterval(ping);
          res.end();
        };
        const send = () => {
          if (stopped) return;
          try {
            for (const item of service.eventsAfter(segments[2], cursor, principal)) {
              cursor = item.sequence;
              res.write(`id: ${item.sequence}\ndata: ${JSON.stringify(item)}\n\n`);
            }
          } catch {
            // Authorization revoked or run removed mid-stream: end honestly instead of replaying stale data.
            stop();
          }
        };
        const pump = setInterval(send, 1000);
        const ping = setInterval(() => {
          if (!stopped) res.write(': keep-alive\n\n');
        }, 15_000);
        req.on('close', stop);
        res.on('close', stop);
        send();
        return;
      }
      if (segments.length === 4 && segments[3] === 'events' && method === 'GET') {
        json(res, 200, service.runEvents(segments[2], offset(), limit(50), principal));
        return;
      }
      if (segments.length === 4 && segments[3] === 'inputs') {
        if (method === 'GET') {
          const page = service.inputs(segments[2], offset(), limit(), principal);
          json(res, 200, { total: page.total, items: page.items.map(publicInput) });
          return;
        }
        if (method === 'POST') {
          const body = objectBody(await readBody(req));
          if (!('input' in body)) throw new PlatformError('REQUEST_JSON_INVALID', 'input');
          json(res, 201, publicInput(service.appendInput(segments[2], body.input, principal)));
          return;
        }
      }
      if (segments.length === 4 && segments[3] === 'cancel' && method === 'POST') {
        const body = objectBody(await readBody(req));
        if (!Number.isSafeInteger(body.expectedRevision)) {
          throw new PlatformError('RUN_REVISION_INVALID');
        }
        const result = await service.cancelRun(segments[2], body.expectedRevision as number, principal);
        json(res, 200, { record: publicRun(result.record), cancelSettled: result.cancelSettled });
        return;
      }
      if (segments.length === 4 && segments[3] === 'interactions' && method === 'GET') {
        const items = service.interactions(segments[2], principal);
        json(res, 200, { total: items.length, items });
        return;
      }
      if (segments.length === 4 && segments[3] === 'artifacts' && method === 'GET') {
        json(res, 200, { items: service.artifacts(segments[2], principal).map(publicArtifact) });
        return;
      }
      if (
        segments.length >= 6 &&
        segments[3] === 'artifacts' &&
        segments[segments.length - 1] === 'download' &&
        (method === 'GET' || method === 'HEAD')
      ) {
        let name: string;
        try {
          name = segments.slice(4, -1).map((segment) => decodeURIComponent(segment)).join('/');
        } catch {
          throw new PlatformError('RUN_ARTIFACT_NOT_FOUND');
        }
        const artifact = await service.readArtifact(segments[2], name, principal);
        const fallback = artifact.name.replace(/[^A-Za-z0-9._-]/g, '_');
        res.writeHead(200, {
          'Content-Type': artifact.mediaType ?? 'application/octet-stream',
          'Content-Length': artifact.data.byteLength,
          'Content-Disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(method === 'HEAD' ? undefined : artifact.data);
        return;
      }
      if (segments.length === 4 && segments[3] === 'retry' && method === 'POST') {
        const raw = await readBody(req);
        const body = raw === undefined ? {} : objectBody(raw);
        json(
          res,
          201,
          publicRun(
            service.retryRunWithModel(segments[2], principal, {
              ...(body.modelSelectionId !== undefined
                ? { modelSelectionId: body.modelSelectionId as string }
                : {}),
              ...(body.modelOptions !== undefined ? { modelOptions: body.modelOptions } : {}),
            }),
          ),
        );
        return;
      }
    }
    json(res, 404, { ok: false, code: 'API_ROUTE_NOT_FOUND', detail: url.pathname });
  };

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        let principal: Principal;
        try {
          principal = await authenticate(req);
        } catch (error) {
          json(res, error instanceof AuthorizationError ? 403 : 401, {
            ok: false,
            code: error instanceof Error && 'code' in error ? String(error.code) : 'UNAUTHENTICATED',
            detail: '请求未通过平台身份校验。',
          });
          return;
        }
        await handleApi(req, res, url, principal);
        return;
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && appDir) {
        if (await serveAsset(appDir, url.pathname, req, res)) return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (error) {
      if (!res.headersSent) json(res, errorStatus(error), errorBody(error));
      else res.end();
    }
  });
}

export interface RunningWorkbenchApi {
  server: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function startWorkbenchServer(options: WorkbenchApiOptions & { port?: number }): Promise<RunningWorkbenchApi> {
  const server = createWorkbenchServer(options);
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      }),
  };
}
