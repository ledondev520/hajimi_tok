/**
 * Input: 二维 SVG 坐标点序列（{ x, y }[]）与基线/纵轴边界参数。
 * Output: 导出 buildSmoothLinePath 与 buildSmoothAreaPath，生成单调三次贝塞尔平滑折线与渐变面积 SVG path 字符串。
 * Pos: 看板图表层通用 SVG 曲线渲染引擎，供 DailyUsageCard、CacheHitRateCard 与 ModelCallChart 复用，消除生硬锯齿折线（src/lib/chartPath.ts）。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */

/** 二维 SVG 绘图点坐标 */
export interface SvgPoint {
  x: number; // 横坐标（px）
  y: number; // 纵坐标（px，向下递增）
}

/**
 * 职责：使用 Fritsch-Carlson 单调三次样条算法将离散点转为平滑 SVG 三次贝塞尔曲线路径，避免曲线过冲越界。
 * 思路：1) 0/1 点返回空串，2 点返回直线；2) 计算相邻斜率并仅在同号段取调和平均切线，保证局部单调不越出 [minY, maxY]；3) 输出紧凑的一位小数 SVG C 指令。
 * 参数：points — 按 x 递增排列的坐标点数组；clampMinY/clampMaxY — 可选纵轴裁剪上下界（px）。
 * 返回值：SVG path 的 d 属性字符串（空串表示无可绘线段）。
 */
export function buildSmoothLinePath(
  points: readonly SvgPoint[],
  clampMinY?: number,
  clampMaxY?: number
): string {
  const n = points.length;
  if (n < 2) return "";
  if (n === 2) {
    return `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)} L${points[1].x.toFixed(1)},${points[1].y.toFixed(1)}`;
  }

  const dx: number[] = new Array(n - 1);
  const slopes: number[] = new Array(n - 1);
  for (let i = 0; i < n - 1; i += 1) {
    const spanX = points[i + 1].x - points[i].x;
    dx[i] = spanX;
    slopes[i] = spanX > 1e-6 ? (points[i + 1].y - points[i].y) / spanX : 0;
  }

  // 1. 计算每个节点的单调切线斜率 m[i]
  const tangents: number[] = new Array(n).fill(0);
  tangents[0] = slopes[0];
  tangents[n - 1] = slopes[n - 2];
  for (let i = 1; i < n - 1; i += 1) {
    const s0 = slopes[i - 1];
    const s1 = slopes[i];
    if (s0 * s1 <= 0) {
      tangents[i] = 0;
    } else {
      const w0 = 2 * dx[i] + dx[i - 1];
      const w1 = dx[i] + 2 * dx[i - 1];
      tangents[i] = (w0 + w1) / (w0 / s0 + w1 / s1);
    }
  }

  const clampY = (val: number): number => {
    let out = val;
    if (typeof clampMinY === "number" && out < clampMinY) out = clampMinY;
    if (typeof clampMaxY === "number" && out > clampMaxY) out = clampMaxY;
    return out;
  };

  // 2. 生成平滑三次贝塞尔路径
  const parts: string[] = [`M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`];
  for (let i = 0; i < n - 1; i += 1) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const h = dx[i];
    if (h <= 1e-6) {
      parts.push(`L${p1.x.toFixed(1)},${p1.y.toFixed(1)}`);
      continue;
    }
    const c1x = p0.x + h / 3;
    const c1y = clampY(p0.y + (tangents[i] * h) / 3);
    const c2x = p1.x - h / 3;
    const c2y = clampY(p1.y - (tangents[i + 1] * h) / 3);
    parts.push(
      `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p1.x.toFixed(1)},${p1.y.toFixed(1)}`
    );
  }
  return parts.join(" ");
}

/**
 * 职责：基于单调平滑曲线生成闭合面积填充 SVG path，贴合图表底基线用于柔和渐变填充。
 * 参数：points — 坐标点数组；baselineY — 绘图区底部基线纵坐标（px）；clampMinY/clampMaxY — 可选裁剪边界。
 * 返回值：闭合 SVG path d 字符串。
 */
export function buildSmoothAreaPath(
  points: readonly SvgPoint[],
  baselineY: number,
  clampMinY?: number,
  clampMaxY?: number
): string {
  if (points.length < 2) return "";
  const curve = buildSmoothLinePath(points, clampMinY, clampMaxY);
  if (!curve) return "";
  const first = points[0];
  const last = points[points.length - 1];
  return `${curve} L${last.x.toFixed(1)},${baselineY.toFixed(1)} L${first.x.toFixed(1)},${baselineY.toFixed(1)} Z`;
}
