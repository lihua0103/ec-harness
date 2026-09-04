/**
 * 企业设置 UI 的简单 HTML 页面
 * 通过静态文件服务提供，使用 fetch API 与后端通信
 */

export const ENTERPRISE_SETTINGS_HTML = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>企业设置 - DSH Enterprise</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: #f5f5f5;
      color: #333;
      padding: 20px;
    }
    
    .container {
      max-width: 800px;
      margin: 0 auto;
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
      padding: 24px;
    }
    
    h1 {
      font-size: 24px;
      font-weight: 600;
      margin-bottom: 8px;
      color: #1a1a1a;
    }
    
    .subtitle {
      font-size: 14px;
      color: #666;
      margin-bottom: 32px;
    }
    
    .setting-group {
      border-bottom: 1px solid #e5e5e5;
      padding: 20px 0;
    }
    
    .setting-group:last-child {
      border-bottom: none;
    }
    
    .setting-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
    }
    
    .setting-info {
      flex: 1;
    }
    
    .setting-label {
      font-size: 15px;
      font-weight: 500;
      margin-bottom: 4px;
      color: #1a1a1a;
    }
    
    .setting-description {
      font-size: 13px;
      color: #666;
      line-height: 1.5;
    }
    
    .toggle-container {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .toggle {
      position: relative;
      width: 44px;
      height: 24px;
      background: #ccc;
      border-radius: 12px;
      cursor: pointer;
      transition: background 0.3s;
    }
    
    .toggle.checked {
      background: #0066ff;
    }
    
    .toggle.disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    
    .toggle-knob {
      position: absolute;
      top: 2px;
      left: 2px;
      width: 20px;
      height: 20px;
      background: white;
      border-radius: 50%;
      transition: transform 0.3s;
    }
    
    .toggle.checked .toggle-knob {
      transform: translateX(20px);
    }
    
    .status {
      font-size: 12px;
      padding: 4px 8px;
      border-radius: 4px;
      display: inline-block;
    }
    
    .status.success {
      background: #d4edda;
      color: #155724;
    }
    
    .status.error {
      background: #f8d7da;
      color: #721c24;
    }
    
    .status.loading {
      background: #d1ecf1;
      color: #0c5460;
    }
    
    .footer {
      margin-top: 32px;
      padding-top: 20px;
      border-top: 1px solid #e5e5e5;
      font-size: 12px;
      color: #999;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>企业设置</h1>
    <p class="subtitle">配置 DSH Enterprise 的企业级功能</p>
    
    <div class="setting-group">
      <div class="setting-row">
        <div class="setting-info">
          <div class="setting-label">
            数据安全
            <span id="status" class="status loading">加载中...</span>
          </div>
          <div class="setting-description">
            默认启用。启用时 SAS/XPT/CSV 数据集行值与 doc/ 外 spec 需求辅助 Excel 单元格值不会进入 AI 上下文；doc/ 全目录需求文件完整分片可读。关闭后不做任何拦截。
          </div>
        </div>
        <div class="toggle-container">
          <div id="toggle" class="toggle disabled" aria-disabled="true">
            <div class="toggle-knob"></div>
          </div>
        </div>
      </div>
    </div>
    
    <div class="footer">
      DSH Enterprise v0.1.0 | 数据安全功能由企业插件提供
    </div>
  </div>

  <script>
    const toggle = document.getElementById('toggle')
    const status = document.getElementById('status')
    let currentEnabled = true
    let loading = false

    function updateUI() {
      toggle.classList.toggle('checked', currentEnabled)
    }

    function setBusy(busy) {
      loading = busy
      toggle.classList.toggle('disabled', busy)
      toggle.setAttribute('aria-disabled', busy ? 'true' : 'false')
    }

    async function loadStatus() {
      try {
        status.textContent = '加载中...'
        status.className = 'status loading'
        setBusy(true)

        const response = await fetch('/api/settings/data-security')
        if (!response.ok) {
          throw new Error('HTTP ' + response.status)
        }

        const data = await response.json()
        if (data.policy !== 'two-value-interception' || typeof data.enabled !== 'boolean') {
          throw new Error('unexpected data security policy')
        }
        currentEnabled = data.enabled
        updateUI()
        status.textContent = '已加载'
        status.className = 'status success'

        setTimeout(() => {
          status.style.display = 'none'
        }, 2000)
      } catch (err) {
        console.error('Failed to load status:', err)
        status.textContent = '加载失败'
        status.className = 'status error'
        currentEnabled = true
        updateUI()
      } finally {
        setBusy(false)
      }
    }

    async function toggleEnabled() {
      if (loading) return
      const target = !currentEnabled
      try {
        setBusy(true)
        status.style.display = ''
        status.textContent = '更新中...'
        status.className = 'status loading'
        const response = await fetch('/api/settings/data-security', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-DSH-Settings': '1' },
          body: JSON.stringify({ enabled: target }),
        })
        if (!response.ok) throw new Error('HTTP ' + response.status)
        const data = await response.json()
        if (typeof data.enabled !== 'boolean') throw new Error('unexpected response')
        currentEnabled = data.enabled
        updateUI()
        status.textContent = '已更新'
        status.className = 'status success'
        setTimeout(() => { status.style.display = 'none' }, 2000)
      } catch (err) {
        console.error('Failed to update status:', err)
        status.style.display = ''
        status.textContent = '更新失败'
        status.className = 'status error'
        updateUI()
      } finally {
        setBusy(false)
      }
    }

    toggle.addEventListener('click', toggleEnabled)

    // 初始加载
    loadStatus()
  </script>
</body>
</html>
`
