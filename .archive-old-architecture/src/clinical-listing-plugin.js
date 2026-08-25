import { defineTool } from '@deepseek-ai/dsh-tools';

const SCENARIOS = ['medical', 'rbqm', 'manual', 'report'];

const LISTING_TIMEOUT_DEFAULT_MS = {
  listing_inspect: 600_000,
  listing_run_code: 600_000,
  listing_publish: 900_000,
};

function listingTimeoutMs(config, operation) {
  const override = Number(config?.listingTimeoutMs?.[operation] ?? config?.listingTimeoutMs);
  if (Number.isFinite(override) && override > 0) return override;
  return LISTING_TIMEOUT_DEFAULT_MS[operation];
}

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    action: { type: 'string', required: true },
    inspection: { type: 'object', additionalProperties: true },
    receipt: { type: 'object', additionalProperties: true },
    reason: { type: 'string' },
    code: { type: 'string' },
    retryable: { type: 'boolean' },
  },
};

const CODE_SCHEMA = {
  type: 'string',
  required: true,
  description: 'pandas 变换代码。可用 datasets（按名取 DataFrame）、pd、np、math。禁用 import、下划线属性、文件/网络 IO。数据值不回传，只回行数/列名/dtype。',
};

/**
 * 2026-08-25 重构 v2：
 * - flowGuidanceEnabled 固定为 true，流程引导始终生效
 * - 不再依赖 policy 状态
 */
function workflowContext(config, policy, exec) {
  // 2026-08-25 P0：开关状态实时求值。worker 侧 _handle() 读的键名是
  // dataInterceptionEnabled，此前只传了 dataProtectionEnabled（且是启动期
  // 快照），worker 取不到便回落默认 True——关闭开关后 listing 家族仍走
  // uat-local 门禁并被 LOCAL_DATA_ACCESS_REQUIRED 拦住。
  const enabled = typeof policy?.isEnabled === 'function'
    ? policy.isEnabled()
    : (config.dataInterceptionEnabled ?? true);
  return {
    // 流程引导固定为 true，不受开关控制
    flowGuidanceEnabled: true,
    dataInterceptionEnabled: enabled,
    dataProtectionEnabled: enabled,
    localDataAccess: config.localDataAccess,
    localDataRoot: exec?.agent?.session?.header?.cwd ?? config.localDataRoot,
    outputPlaneRoot: config.outputPlaneRoot,
    credentialsDir: config.credentialsDir,
    sessionId: exec?.agent?.sessionId ?? config.sessionId ?? 'unknown-session',
    userId: exec?.agent?.userId ?? config.userId ?? 'anonymous',
  };
}

function commonParameters() {
  return {
    project: {
      type: 'string',
      required: true,
      description: '当前会话工作区内的相对项目目录',
    },
    scenario: {
      type: 'string',
      enum: SCENARIOS,
      description: '可选；省略时由 specification 自动推断',
    },
    credentialRef: {
      type: 'string',
      required: true,
      description: '加密归档密码引用，不是密码本身',
    },
  };
}

function registerTool(ctx, runtime, config, policy, definition) {
  return ctx.tools.register(defineTool({
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    ...definition,
    execute: async (args, exec) => {
      const timeoutMs = listingTimeoutMs(config, definition.operation);
      let response;
      try {
        response = await runtime.request({
          operation: definition.operation,
          project: args.project,
          scenario: args.scenario,
          code: args.code,
          credentialRef: args.credentialRef,
          context: workflowContext(config, policy, exec),
        }, { timeoutMs, lane: 'heavy' });
      } catch (error) {
        if (!/timeout after \d+ms/.test(String(error?.message ?? ''))) throw error;
        return {
          ok: false,
          action: definition.operation.replace(/_/g, '-'),
          code: 'LISTING_TIMEOUT',
          retryable: true,
          reason: '本地 listing 操作在 ' + Math.round(timeoutMs / 1000) + 's 内未完成。真实记录未出域，可原样重试。',
        };
      }
      const { requestId: _id, ...businessResponse } = response;
      if (!response.ok && response.code === 'LOCAL_DATA_ACCESS_REQUIRED') {
        return { ...businessResponse, action: definition.operation.replace(/_/g, '-') };
      }
      if (!response.ok) throw new Error(response.reason || 'clinical listing operation failed');
      return businessResponse;
    },
  }));
}

/**
 * 2026-08-25 重构 v2：
 * - Listing 插件始终注册
 * - 流程引导始终生效，不受开关控制
 */
export function registerClinicalListingPlugin(ctx, runtime, config, policy) {
  const disposers = [];

  // listing_inspect - 读取规格和 schema
  disposers.push(registerTool(ctx, runtime, config, policy, {
    name: 'clinical_listing_inspect',
    operation: 'listing_inspect',
    description: '读取临床 Listing spec 正文、ALS 映射和 SAS/XPT schema 结构，只返回需求与元数据，不返回真实数据值。',
    parameters: commonParameters(),
    presentCall: (args) => ({
      card: 'generic',
      title: 'Listing Inspect: ' + (args.scenario ?? 'default'),
      kind: 'search',
      content: [{
        type: 'text',
        text: '阶段 1/2：读取规格、ALS 与归档目录元数据；不解压临床数据。',
      }],
    }),
  }));

  // listing_run_code - 执行 pandas 代码
  disposers.push(registerTool(ctx, runtime, config, policy, {
    name: 'clinical_listing_run_code',
    operation: 'listing_run_code',
    description: '在本地沙箱执行 pandas 变换代码并返回聚合元数据信封（行数/列名/dtype/空值计数）。数据值绝不出域。',
    parameters: { ...commonParameters(), code: CODE_SCHEMA },
    presentCall: (args) => ({
      card: 'workflow',
      title: 'Listing Run Code: ' + (args.scenario ?? 'default'),
      kind: 'execute',
    }),
  }));

  // listing_publish - 发布 Excel 交付物
  disposers.push(registerTool(ctx, runtime, config, policy, {
    name: 'clinical_listing_publish',
    operation: 'listing_publish',
    description: '重放最近一次成功代码，产出 Excel 交付物，返回 artifact 元数据。',
    parameters: commonParameters(),
    presentCall: (args) => ({
      card: 'workflow',
      title: 'Listing Publish: ' + (args.scenario ?? 'default'),
      kind: 'execute',
    }),
  }));

  // 注册系统提示
  if (ctx.systemPrompt?.section) {
    disposers.push(ctx.systemPrompt.section({
      name: 'tool:clinical-listing-lifecycle',
      order: 95,
      text: '临床 Listing 使用固定工作流：先调用 clinical_listing_inspect 理解 spec、ALS 字段结构和本地 schema；再用 clinical_listing_run_code 提交 pandas 代码，并根据返回的执行反馈持续迭代；结果稳定后调用 clinical_listing_publish 发布 Excel。优先使用这三个专用工具完成 inspect -> run -> iterate -> publish 全流程。',
    }));
  }

  return () => disposers.forEach((dispose) => dispose?.());
}
