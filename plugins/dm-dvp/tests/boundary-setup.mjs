// 测试进程默认按「脱敏模式」运行：既有用例锁定的是脱敏数据边界。
// 否则一旦部署目录同步出了 data-boundary.json（全量模式），未显式指定模式的用例会整体翻转。
// 全量模式用例（tests/data-boundary.test.ts）自行设置 DM_DATA_BOUNDARY。
// 经 package.json 的 test 脚本以 --import 预加载；node --test 为每个测试文件起的子进程同样会预加载。
process.env.DM_DATA_BOUNDARY ??= 'redacted';
