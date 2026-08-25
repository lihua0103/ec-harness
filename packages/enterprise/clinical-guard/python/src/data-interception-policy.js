/**
 * data-interception-policy.js - 数据出域拦截策略
 *
 * 2026-08-25 重构 v2：
 * - 开关只控制数据拦截
 * - 开关切换时触发 onSwitch 回调，通知 Harness 重启进程
 */

export function createDataInterceptionPolicy(initialEnabled = true, options = {}) {
  if (typeof initialEnabled !== 'boolean') {
    throw new TypeError('initialEnabled must be a boolean');
  }

  let enabled = initialEnabled;

  return Object.freeze({
    /**
     * 获取当前开关状态
     * - true: 数据拦截已启用
     * - false: 数据拦截已关闭
     */
    isEnabled() {
      return enabled;
    },

    /**
     * 设置开关状态
     * @param {boolean} nextEnabled - 新的开关状态
     * @param {object} metadata - 附加元数据
     */
    setEnabled(nextEnabled, metadata = {}) {
      if (typeof nextEnabled !== 'boolean') {
        throw new TypeError('dataInterceptionEnabled must be a boolean');
      }

      const previousEnabled = enabled;
      enabled = nextEnabled;

      // 触发变更回调
      options.onChange?.({
        previousEnabled,
        enabled,
        ...metadata,
      });

      // 开关切换时触发重启回调
      if (previousEnabled !== enabled) {
        console.error(
          `[clinical-data-guard] 开关切换: ${previousEnabled} → ${enabled}，触发进程重启`
        );

        // 触发 onSwitch 回调，通知 Harness 重启进程
        options.onSwitch?.({
          previousEnabled,
          enabled,
          reason: 'data_interception_switch',
          source: metadata.source ?? 'runtime',
          timestamp: new Date().toISOString(),
        });
      }

      return enabled;
    },
  });
}
