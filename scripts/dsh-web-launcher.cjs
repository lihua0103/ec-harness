// DSH Web 启动器：tsx 加载器已由父进程以 `--import tsx/esm`（cwd=upstream）
// 注册完毕后运行本文件。在此之前把工作目录切到项目根，使 web profile 的
// 沙箱 workspaceRoot(=process.cwd()) 落在项目根：agent 可直接读写 .runtime 下
// 的方案输入与产出，不写入 upstream 锁定源码，也不触发逐次审批。
//
// bin.ts 以 import.meta.main 守卫自执行；作为模块导入时须显式调用 runCli()。
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const projectRoot = path.resolve(__dirname, '..')
const bin = path.join(projectRoot, 'upstream', 'deepseek-harness-git', 'apps', 'cli', 'src', 'bin.ts')

process.chdir(projectRoot)
import(pathToFileURL(bin).href)
  .then(module => module.runCli())
  .catch(error => {
    console.error(error && error.stack ? error.stack : String(error))
    process.exitCode = 1
  })