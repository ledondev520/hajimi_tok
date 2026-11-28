/**
 * Input: process.argv 命令行参数、./aggregator 与 ./cliRender。
 * Output: 向终端标准输出打印 AntiGravity 会话 Token 消耗统计表或 JSON 结果。
 * Pos: 终端一键命令行统计入口（npm run stats）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import { createTelemetryService } from "./aggregator";
import { parseCliArgs, renderCliHelp, renderCliReport } from "./cliRender";

/**
 * 职责：解析命令行参数并输出本地 AntiGravity 会话 Token 统计结果。
 * 参数：argv — 原始参数列表（通常为 process.argv.slice(2)）。
 */
function runCli(argv: string[]): void {
  // 0. 解析 CLI 参数并处理 --help
  const args = parseCliArgs(argv);
  if (args.help) {
    process.stdout.write(`${renderCliHelp()}\n`);
    return;
  }

  // 1.1. 创建遥测聚合服务并查询结果
  const service = createTelemetryService(args.dataDir);
  const summary = service.getSummary({
    days: args.days,
    workspace: args.workspace,
    model: args.model,
    includeArchived: true,
  });

  // 1.2. 按 --json 或对齐表格输出
  if (args.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderCliReport(summary, args.limit)}\n`);
  }
}

runCli(process.argv.slice(2));
