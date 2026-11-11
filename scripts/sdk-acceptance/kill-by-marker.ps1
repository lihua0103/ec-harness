param([string]$Marker)
# 按 overlay 标记精确匹配套件拉起的 dsh 子进程 PID（命令行含 --patch <overlay 路径>）。
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like ("*" + $Marker + "*") } |
  ForEach-Object { $_.ProcessId }
