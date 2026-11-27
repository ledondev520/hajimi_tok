/**
 * Input: node:fs 与 node:path 文件系统接口，扫描当前仓库源码与目录文档。
 * Output: 校验全局强制规则（零 .css/.scss、单文件 <=800 行、文件头注释、目录 README 规范），违规时返回非零退出码。
 * Pos: 自动化工程规范门禁脚本（npm run check:rules）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd(); // 仓库根目录路径
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", "logs", "RESULTS", "PATCHES"]); // 跳过扫描的非源码目录
const CODE_DIRS_REQUIRING_DOC = [
  "server",
  "src",
  "src/components",
  "src/components/ui",
  "src/lib",
  "src/types",
  "scripts",
  "tests",
]; // 存在时必须具备合规 README.md/INDEX.md 的职责目录清单
const SOURCE_EXTS = new Set([".ts", ".tsx", ".mjs", ".js", ".jsx"]); // 需要检查行数与头注释的源码后缀
const FORBIDDEN_STYLE_EXTS = new Set([".css", ".scss"]); // 严禁在仓库源码中出现的样式后缀

/**
 * 职责：递归遍历指定目录并收集全部文件路径。
 * 参数：dir — 起始扫描目录；acc — 累积结果数组。
 * 返回值：文件绝对路径列表。
 */
function walkFiles(dir, acc = []) {
  // 0. 读取目录项并过滤忽略目录
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    // 1.1. 子目录递归，普通文件入队
    if (entry.isDirectory()) {
      walkFiles(full, acc);
    } else if (entry.isFile()) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * 职责：执行全量全局规范校验并输出诊断报告。
 * 返回值：违规条目字符串数组（空数组表示全部通过）。
 */
function runComplianceChecks() {
  const errors = []; // 累积发现的规则违例项
  const allFiles = walkFiles(ROOT);

  // 1. 检查源码文件：禁止 .css/.scss、行数 <=800、文件头 Input/Output/Pos 与尾句声明
  for (const filePath of allFiles) {
    const rel = path.relative(ROOT, filePath);
    const ext = path.extname(filePath).toLowerCase();

    if (FORBIDDEN_STYLE_EXTS.has(ext)) {
      errors.push(`[Rule-F] 发现被禁止的样式文件: ${rel}`);
      continue;
    }

    if (!SOURCE_EXTS.has(ext)) continue;

    const content = fs.readFileSync(filePath, "utf8");
    const lineCount = content.split("\n").length;
    if (lineCount > 800) {
      errors.push(`[Rule-C] 文件超过 800 行上限 (${lineCount} 行): ${rel}`);
    }

    const headSlice = content.slice(0, 1200);
    if (
      !headSlice.includes("Input:") ||
      !headSlice.includes("Output:") ||
      !headSlice.includes("Pos:") ||
      !headSlice.includes("我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。")
    ) {
      errors.push(`[Rule-B] 文件头注释缺少 Input/Output/Pos 或同步声明尾句: ${rel}`);
    }
  }

  // 2. 检查职责目录文档：必须含 README.md 或 INDEX.md 且首行符合强制口令
  for (const relDir of CODE_DIRS_REQUIRING_DOC) {
    const absDir = path.join(ROOT, relDir);
    if (!fs.existsSync(absDir)) continue;
    const readmePath = path.join(absDir, "README.md");
    const indexPath = path.join(absDir, "INDEX.md");
    const docPath = fs.existsSync(readmePath) ? readmePath : fs.existsSync(indexPath) ? indexPath : null;
    if (!docPath) {
      errors.push(`[Rule-A] 目录缺少 README.md 或 INDEX.md: ${relDir}`);
      continue;
    }
    const docContent = fs.readFileSync(docPath, "utf8").trimStart();
    if (!docContent.startsWith("若本文件夹结构或内容变化，请更新本文件。")) {
      errors.push(`[Rule-A] 目录文档首行未包含强制更新提示语: ${path.relative(ROOT, docPath)}`);
    }
  }

  return errors;
}

const violations = runComplianceChecks();
if (violations.length > 0) {
  console.error("✗ 工程规范校验未通过：");
  for (const v of violations) {
    console.error("  -", v);
  }
  process.exit(1);
} else {
  console.log("✓ 工程规范校验全部通过（零 CSS/SCSS、全文件 <=800 行、头注释与目录文档齐全）。");
}
