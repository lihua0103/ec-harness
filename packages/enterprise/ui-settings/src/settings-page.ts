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
            启用后将阻止 SAS 数据集（.sas7bdat、.xpt）和 data/spec 目录下的敏感 Excel 文件发送给 AI 模型。
            默认启用，确保临床试验数据安全。
          </div>
        </div>
        <div class="toggle-container">
          <div id="toggle" class="toggle disabled">
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
    
    // 加载初始状态
    async function loadStatus() {
      try {
        status.textContent = '加载中...'
        status.className = 'status loading'
        loading = true
        
        const response = await fetch('/api/settings/data-security')
        if (!response.ok) {
          throw new Error('HTTP ' + response.status)
        }
        
        const data = await response.json()
        currentEnabled = data.enabled ?? true
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
        currentEnabled = true // 默认启用
        updateUI()
      } finally {
        loading = false
        toggle.classList.remove('disabled')
      }
    }
    
    // 更新 UI
    function updateUI() {
      if (currentEnabled) {
        toggle.classList.add('checked')
      } else {
        toggle.classList.remove('checked')
      }
    }
    
    // 切换状态
    async function handleToggle() {
      if (loading) return
      
      const newValue = !currentEnabled
      
      try {
        loading = true
        toggle.classList.add('disabled')
        status.style.display = 'inline-block'
        status.textContent = '保存中...'
        status.className = 'status loading'
        
        const response = await fetch('/api/settings/data-security', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ enabled: newValue }),
        })
        
        if (!response.ok) {
          throw new Error('HTTP ' + response.status)
        }
        
        const data = await response.json()
        currentEnabled = data.enabled ?? newValue
        updateUI()
        
        status.textContent = '已保存'
        status.className = 'status success'
        
        setTimeout(() => {
          status.style.display = 'none'
        }, 2000)
      } catch (err) {
        console.error('Failed to update:', err)
        status.textContent = '保存失败'
        status.className = 'status error'
        
        // 恢复原状态
        await loadStatus()
      } finally {
        loading = false
        toggle.classList.remove('disabled')
      }
    }
    
    // 绑定事件
    toggle.addEventListener('click', handleToggle)
    
    // 初始加载
    loadStatus()
  </script>
</body>
</html>
`
