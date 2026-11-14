/** Same-origin client for the platform workbench API. No mock data and no hidden fallback. */

export class ApiError extends Error {
  constructor(code, detail, status) {
    super(detail || code);
    this.code = code;
    this.detail = detail || code;
    this.status = status;
  }
}

export class PlatformApi {
  constructor(base = '') {
    this.base = base;
  }

  async request(method, path, body) {
    let response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ApiError('NETWORK_UNAVAILABLE', method === 'GET'
        ? '无法连接平台服务；请重新连接后刷新。'
        : '连接中断，提交结果未知。请先刷新核对工作与运行记录，不要直接重复提交。', 0);
    }
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new ApiError('RESPONSE_INVALID', '平台返回了无法解析的响应。', response.status);
      }
    }
    if (!response.ok) {
      throw new ApiError(payload?.code ?? 'REQUEST_FAILED', payload?.detail ?? `请求失败（${response.status}）`, response.status);
    }
    return payload;
  }

  /** Read every page; a truncated or inconsistent response is never presented as complete. */
  async allPages(path) {
    const items = [];
    let offset = 0;
    for (;;) {
      const page = await this.request('GET', `${path}${path.includes('?') ? '&' : '?'}offset=${offset}&limit=100`);
      if (!Array.isArray(page?.items) || !Number.isSafeInteger(page.total) || page.total < 0) {
        throw new ApiError('PAGE_INVALID', '平台分页响应无效。', 0);
      }
      items.push(...page.items);
      offset += page.items.length;
      if (offset >= page.total) return { total: page.total, items };
      if (!page.items.length) throw new ApiError('PAGE_INCOMPLETE', '平台记录尚未完整加载，请刷新重试。', 0);
    }
  }

  bootstrap() { return this.request('GET', '/api/workbench'); }
  pickDirectory() { return this.request('POST', '/api/fs/pick'); }
  projects() { return this.request('GET', '/api/projects'); }
  createProject(input) { return this.request('POST', '/api/projects', input); }
  workspaces(projectId) { return this.request('GET', `/api/projects/${encodeURIComponent(projectId)}/workspaces`); }
  createWorkspace(projectId, input) { return this.request('POST', `/api/projects/${encodeURIComponent(projectId)}/workspaces`, input); }
  bindWorkspace(workId, workspaceId) { return this.request('PUT', `/api/works/${encodeURIComponent(workId)}/workspace`, { workspaceId }); }
  draft(workId) { return this.request('GET', `/api/works/${encodeURIComponent(workId)}/draft`); }
  saveDraft(workId, text, expectedRevision) { return this.request('PUT', `/api/works/${encodeURIComponent(workId)}/draft`, { text, expectedRevision }); }
  listWorks() { return this.allPages('/api/works'); }
  createWork(draft) { return this.request('POST', '/api/works', draft); }
  getWork(workId) { return this.request('GET', `/api/works/${encodeURIComponent(workId)}`); }
  archiveWork(workId) { return this.request('POST', `/api/works/${encodeURIComponent(workId)}/archive`); }
  workRuns(workId) { return this.allPages(`/api/works/${encodeURIComponent(workId)}/runs`); }
  createRun(workId, input) { return this.request('POST', `/api/works/${encodeURIComponent(workId)}/runs`, input); }
  run(runId) { return this.request('GET', `/api/runs/${encodeURIComponent(runId)}`); }
  runEvents(runId) { return this.allPages(`/api/runs/${encodeURIComponent(runId)}/events`); }
  runInputs(runId) { return this.allPages(`/api/runs/${encodeURIComponent(runId)}/inputs`); }
  runInteractions(runId) { return this.allPages(`/api/runs/${encodeURIComponent(runId)}/interactions`); }
  answerInteraction(interactionId, answer) {
    return this.request('POST', `/api/interactions/${encodeURIComponent(interactionId)}/answer`, { answer });
  }
  appendInput(runId, input) { return this.request('POST', `/api/runs/${encodeURIComponent(runId)}/inputs`, { input }); }
  cancelRun(runId, expectedRevision) {
    return this.request('POST', `/api/runs/${encodeURIComponent(runId)}/cancel`, { expectedRevision });
  }
  reconcileRun(runId) { return this.request('POST', `/api/runs/${encodeURIComponent(runId)}/reconcile`); }
  retryRun(runId, modelSelectionId) {
    return this.request('POST', `/api/runs/${encodeURIComponent(runId)}/retry`, modelSelectionId ? { modelSelectionId } : {});
  }
  artifacts(runId) { return this.request('GET', `/api/runs/${encodeURIComponent(runId)}/artifacts`); }
  models() { return this.request('GET', '/api/models'); }
  setPreference(selectionId) { return this.request('PUT', '/api/models/preference', { selectionId }); }
}
