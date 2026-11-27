/**
 * Input: AntiGravity 会话 SQLite 库 gen_metadata 表中的原始 Protobuf 二进制字节流（Uint8Array）。
 * Output: 导出 ParsedGenMetadata 结构、decodeGenMetadata 零依赖解码器及测试用 Wire 编码辅助函数。
 * Pos: 服务端遥测采集层的底层二进制协议解析器，负责安全提取模型名、思考 Token、上下文窗口与延迟。
 * 我被更新时，必须同步更新本头注释 + 所属目录 README/INDEX。
 */

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER); // JS 安全整数上限（用于拦截负 int64 补码溢出）
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: false }); // 共享 UTF-8 解码器实例
const UTF8_ENCODER = new TextEncoder(); // 共享 UTF-8 编码器实例（供测试构造 Wire 数据）

/** 从 gen_metadata.data 解码出的单步推理元数据 */
export interface ParsedGenMetadata {
  modelId: string; // 内部模型标识（subfield 1.19）
  modelName: string; // 可读模型名称（subfield 1.21）
  inputTokens: number; // 未缓存新增输入 Token（usage.2）
  cacheReadTokens: number; // 命中缓存读取 Token（usage.5）
  outputTokens: number; // 总输出 Token（usage.3）
  thinkingTokens: number; // 思考链消耗 Token（usage.9）
  responseTokens: number; // 正文与工具输出 Token（usage.10）
  contextUsed: number; // 当前上下文已用 Token（subfield 1.9.10.1）
  contextLimit: number; // 模型上下文上限（subfield 1.9.10.4）
  latencyMs: number; // 端到端总耗时毫秒（subfield 1.11 首包延迟 + subfield 1.12 流式生成耗时）
  ttftMs: number; // 首包延迟毫秒（subfield 1.11 Duration）
  lastStepIndex: number | null; // 映射轨迹步序索引（subfield 1.20["last_step_index"]）
  rootCascadeId: string; // 根级联会话标识（subfield 1.20["root_cascade_id"]）
  cascadeId: string; // 当前级联会话标识（subfield 1.20["cascade_id"]）
}

/** 内部通用 Protobuf Wire 字段切片表示 */
interface WireField {
  fieldNumber: number; // 字段编号（tag >> 3）
  wireType: number; // 线类型（0=varint, 1=fixed64, 2=bytes, 5=fixed32）
  varint?: bigint; // 当 wireType === 0 时的无符号 64 位整数值
  bytes?: Uint8Array; // 当 wireType === 2 时的子字节视图
}

/**
 * 职责：使用 BigInt 从字节缓冲区指定偏移读取单个 Protobuf Varint。
 * 思路：按 7-bit 小端分组累加至 BigInt，避免 64 位负整数补码（如 0xffffffffffffffff）触发 JS 32 位移位溢出。
 * 参数：buf — 源字节数组；offset — 起始读取偏移。
 * 返回值：成功时返回 { value, nextOffset }，截断或超过 10 字节上限时返回 null。
 */
export function readVarint(
  buf: Uint8Array,
  offset: number,
): { value: bigint; nextOffset: number } | null {
  // 0. 初始化累加器与位移计数
  let result = 0n; // 累积解码的无符号 BigInt 值
  let shift = 0n; // 当前 7-bit 分组位移量
  let pos = offset; // 当前游标位置

  // 1. 逐字节读取，64 位 varint 最多占用 10 个字节（shift < 70n）
  while (pos < buf.length && shift < 70n) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    // 1.1. 最高位 MSB 为 0 表示当前 Varint 结束
    if ((byte & 0x80) === 0) {
      return { value: result, nextOffset: pos };
    }
    shift += 7n;
  }

  // 2. 数据截断或畸形超长 Varint，安全返回 null
  return null;
}

/**
 * 职责：将解码出的 BigInt 安全转换为非负 JS Number 计数值。
 * 思路：对超过 Number.MAX_SAFE_INTEGER 的值（如负 int64 补码 18446744073709551615）归零兜底。
 * 参数：val — 待转换的无符号 BigInt。
 * 返回值：安全范围内的非负整数。
 */
function toSafeNumber(val: bigint | undefined): number {
  // 0. 空值或负补码超大值统一归零
  if (val === undefined || val < 0n) return 0;
  return Number(val <= MAX_SAFE_BIGINT ? val : 0n);
}

/**
 * 职责：扫描单层 Protobuf 消息缓冲区并拆解全部 Wire 字段。
 * 思路：顺序解码 Tag 与对应载荷（支持 wireType 0/1/2/5），遇到未知线类型或截断时立即优雅停止，绝不抛异常。
 * 参数：buf — 单层消息字节切片。
 * 返回值：按出现顺序排列的 WireField 数组。
 */
function parseWireFields(buf: Uint8Array): WireField[] {
  // 0. 初始化结果列表与扫描游标
  const fields: WireField[] = []; // 当前消息层解析出的字段集合
  let pos = 0; // 字节读取游标

  // 1. 循环解码每个字段 Tag 与对应线类型数据
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (!tag || tag.value === 0n) break;

    const wireType = Number(tag.value & 0x07n);
    const fieldNumber = Number(tag.value >> 3n);
    if (fieldNumber <= 0 || !Number.isSafeInteger(fieldNumber)) break;
    pos = tag.nextOffset;

    // 1.1. 按 wireType 分支跳过或提取载荷
    if (wireType === 0) {
      const v = readVarint(buf, pos);
      if (!v) break;
      pos = v.nextOffset;
      fields.push({ fieldNumber, wireType: 0, varint: v.value });
    } else if (wireType === 1) {
      if (pos + 8 > buf.length) break;
      pos += 8;
      fields.push({ fieldNumber, wireType: 1 });
    } else if (wireType === 2) {
      const lenVar = readVarint(buf, pos);
      if (!lenVar) break;
      const remaining = BigInt(buf.length - lenVar.nextOffset);
      if (lenVar.value < 0n || lenVar.value > remaining) break;
      const len = Number(lenVar.value);
      const start = lenVar.nextOffset;
      fields.push({
        fieldNumber,
        wireType: 2,
        bytes: buf.subarray(start, start + len),
      });
      pos = start + len;
    } else if (wireType === 5) {
      if (pos + 4 > buf.length) break;
      pos += 4;
      fields.push({ fieldNumber, wireType: 5 });
    } else {
      // 1.2. 遇到未知或废弃 wireType（3/4/6/7），立即停止避免错位
      break;
    }
  }

  return fields;
}

/**
 * 职责：解码 Protobuf google.protobuf.Duration 子消息为毫秒整数。
 * 思路：提取 field 1 (seconds) 与 field 2 (nanos)，按 Math.round(seconds * 1000 + nanos / 1e6) 折算毫秒。
 * 参数：buf — Duration 子消息字节切片。
 * 返回值：四舍五入后的毫秒耗时。
 */
function decodeDurationMs(buf: Uint8Array): number {
  // 0. 解析秒与纳秒字段
  let seconds = 0;
  let nanos = 0;
  for (const f of parseWireFields(buf)) {
    if (f.wireType === 0 && f.fieldNumber === 1) {
      seconds = toSafeNumber(f.varint);
    } else if (f.wireType === 0 && f.fieldNumber === 2) {
      nanos = toSafeNumber(f.varint);
    }
  }
  // 1. 合并为毫秒整数
  return Math.round(seconds * 1000 + nanos / 1e6);
}

/**
 * 职责：从 usage 子消息中提取输入、输出、缓存读取、思考与回复 Token 数。
 * 思路：解析字段 2/3/5/9/10；当 thinkingTokens 与 responseTokens 均为 0 且 outputTokens > 0 时将 responseTokens 退化为 outputTokens。
 * 参数：usageBytes — usage 子消息字节切片。
 * 返回值：五维 Token 拆解对象。
 */
function decodeUsageSubmessage(usageBytes: Uint8Array): {
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  responseTokens: number;
} {
  // 0. 初始化五项计数器
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let thinkingTokens = 0;
  let responseTokens = 0;

  // 1. 扫描 usage 子消息内各 varint 指标
  for (const uf of parseWireFields(usageBytes)) {
    if (uf.wireType !== 0) continue;
    if (uf.fieldNumber === 2) inputTokens = toSafeNumber(uf.varint);
    else if (uf.fieldNumber === 3) outputTokens = toSafeNumber(uf.varint);
    else if (uf.fieldNumber === 5) cacheReadTokens = toSafeNumber(uf.varint);
    else if (uf.fieldNumber === 9) thinkingTokens = toSafeNumber(uf.varint);
    else if (uf.fieldNumber === 10) responseTokens = toSafeNumber(uf.varint);
  }

  // 2. 对不区分思考链的模型，将全部输出归入 responseTokens
  if (thinkingTokens === 0 && responseTokens === 0 && outputTokens > 0) {
    responseTokens = outputTokens;
  }

  return { inputTokens, cacheReadTokens, outputTokens, thinkingTokens, responseTokens };
}

/**
 * 职责：解码 AntiGravity conversations/<id>.db 中 gen_metadata.data 的完整二进制记录。
 * 思路：
 *   1) 提取顶层 field 1 消息；
 *   2) 优先从 subfield 4 解码 Token 用量，缺失时回退至 subfield 17 -> subfield 2；
 *   3) 从 subfield 9 -> 10 提取上下文窗口，subfield 11/12 提取耗时，subfield 19/21 提取模型名，subfield 20 提取级联与步序字典。
 * 参数：buf — SQLite BLOB 列读取出的 Uint8Array。
 * 返回值：解码成功返回 ParsedGenMetadata；空缓冲或非预期结构返回 null。
 */
export function decodeGenMetadata(buf: Uint8Array): ParsedGenMetadata | null {
  // 0. 校验输入有效性
  if (!(buf instanceof Uint8Array) || buf.length === 0) {
    return null;
  }

  // 1. 提取顶层 field 1 嵌套消息字段集合
  const topFields = parseWireFields(buf);
  const innerFields: WireField[] = []; // 顶层 field 1 内部展开后的全部子字段
  for (const tf of topFields) {
    if (tf.fieldNumber === 1 && tf.wireType === 2 && tf.bytes) {
      innerFields.push(...parseWireFields(tf.bytes));
    }
  }
  if (innerFields.length === 0) {
    return null;
  }

  // 2. 初始化输出结构体默认值
  const parsed: ParsedGenMetadata = {
    modelId: "",
    modelName: "",
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    responseTokens: 0,
    contextUsed: 0,
    contextLimit: 0,
    latencyMs: 0,
    ttftMs: 0,
    lastStepIndex: null,
    rootCascadeId: "",
    cascadeId: "",
  };

  let primaryUsageBytes: Uint8Array | null = null; // 主路径 subfield 4 用量切片
  let fallbackUsageBytes: Uint8Array | null = null; // 备选路径 subfield 17.2 用量切片
  let ttftDurationMs = 0; // subfield 11 首包延迟毫秒
  let streamDurationMs = 0; // subfield 12 流式吐字耗时毫秒

  // 3. 遍历核心元数据子字段
  for (const f of innerFields) {
    if (f.wireType !== 2 || !f.bytes) continue;

    // 3.1. 记录主/备 usage 消息切片
    if (f.fieldNumber === 4) {
      primaryUsageBytes = f.bytes;
    } else if (f.fieldNumber === 17) {
      for (const sub17 of parseWireFields(f.bytes)) {
        if (sub17.fieldNumber === 2 && sub17.wireType === 2 && sub17.bytes) {
          fallbackUsageBytes = sub17.bytes;
        }
      }
    } else if (f.fieldNumber === 9) {
      // 3.2. 解析 subfield 9 -> subfield 10 上下文占用与上限（跳过 9.2 负 int64）
      for (const sub9 of parseWireFields(f.bytes)) {
        if (sub9.fieldNumber === 10 && sub9.wireType === 2 && sub9.bytes) {
          for (const ctxField of parseWireFields(sub9.bytes)) {
            if (ctxField.wireType === 0 && ctxField.fieldNumber === 1) {
              parsed.contextUsed = toSafeNumber(ctxField.varint);
            } else if (ctxField.wireType === 0 && ctxField.fieldNumber === 4) {
              parsed.contextLimit = toSafeNumber(ctxField.varint);
            }
          }
        }
      }
    } else if (f.fieldNumber === 11) {
      // 3.3. 首包延迟（TTFT）与首包后流式输出耗时，端到端总耗时为二者之和
      ttftDurationMs = decodeDurationMs(f.bytes);
    } else if (f.fieldNumber === 12) {
      streamDurationMs = decodeDurationMs(f.bytes);
    } else if (f.fieldNumber === 19) {
      // 3.4. 模型内部标识与展示名称
      parsed.modelId = UTF8_DECODER.decode(f.bytes);
    } else if (f.fieldNumber === 21) {
      parsed.modelName = UTF8_DECODER.decode(f.bytes);
    } else if (f.fieldNumber === 20) {
      // 3.5. repeated map<string, string> 键值扩展项
      let mapKey = "";
      let mapVal = "";
      for (const entryField of parseWireFields(f.bytes)) {
        if (entryField.wireType === 2 && entryField.bytes) {
          if (entryField.fieldNumber === 1) mapKey = UTF8_DECODER.decode(entryField.bytes);
          else if (entryField.fieldNumber === 2) mapVal = UTF8_DECODER.decode(entryField.bytes);
        }
      }
      if (mapKey === "last_step_index") {
        const num = mapVal.trim() === "" ? Number.NaN : Number(mapVal);
        parsed.lastStepIndex = Number.isFinite(num) ? Math.trunc(num) : null;
      } else if (mapKey === "root_cascade_id") {
        parsed.rootCascadeId = mapVal;
      } else if (mapKey === "cascade_id") {
        parsed.cascadeId = mapVal;
      }
    }
  }

  // 4. 合并真实端到端耗时并应用主路径或回退路径的 Token 用量统计
  parsed.ttftMs = ttftDurationMs;
  parsed.latencyMs = ttftDurationMs + streamDurationMs;
  const chosenUsage = primaryUsageBytes ?? fallbackUsageBytes;
  if (chosenUsage) {
    Object.assign(parsed, decodeUsageSubmessage(chosenUsage));
  }

  return parsed;
}

/**
 * 职责：将整数或 BigInt 编码为标准 Protobuf Varint 字节序列（支持负 int64 64 位补码编码）。
 * 思路：通过 BigInt.asUintN(64, ...) 归一化为 64 位无符号整数，再按 7-bit 小端切分输出。
 * 参数：value — 待编码的数值（number 或 bigint）。
 * 返回值：Varint 编码后的 Uint8Array。
 */
export function encodeVarint(value: number | bigint): Uint8Array {
  // 0. 归一化为 64 位无符号整数（负数自动转为 10 字节补码）
  let remaining = BigInt.asUintN(64, typeof value === "bigint" ? value : BigInt(Math.trunc(value)));
  const out: number[] = []; // 输出字节暂存数组

  // 1. 循环按 7 位写出并标记延续位 0x80
  while (remaining >= 0x80n) {
    out.push(Number((remaining & 0x7fn) | 0x80n));
    remaining >>= 7n;
  }
  out.push(Number(remaining));
  return Uint8Array.from(out);
}

/**
 * 职责：拼接多个 Uint8Array 片段为单个连续缓冲区。
 * 思路：先统计总字节长度分配目标数组，再顺序拷贝各分片。
 * 参数：chunks — 待合并的字节切片列表。
 * 返回值：合并后的新 Uint8Array。
 */
export function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  // 0. 计算总长度并分配连续空间
  const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
  const merged = new Uint8Array(totalLen); // 合并后的连续二进制缓冲
  let offset = 0;

  // 1. 顺序填充每个字节块
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

/**
 * 职责：构造单个 Varint 类型（wireType = 0）的 Protobuf 字段字节块。
 * 思路：先写入 (fieldNumber << 3) | 0 标签，再拼接值本身的 Varint。
 * 参数：fieldNumber — 字段号；value — 整数或 BigInt 值。
 * 返回值：编码后的字段字节流。
 */
export function encodeVarintField(fieldNumber: number, value: number | bigint): Uint8Array {
  // 0. 组合字段 Tag 与 Varint 值
  const tag = (BigInt(fieldNumber) << 3n) | 0n;
  return concatBytes(encodeVarint(tag), encodeVarint(value));
}

/**
 * 职责：构造单个 Length-Delimited 类型（wireType = 2）的嵌套消息或原始字节字段。
 * 思路：写入 (fieldNumber << 3) | 2 标签 + 字节长度 Varint + 原始载荷。
 * 参数：fieldNumber — 字段号；payload — 嵌套字节内容。
 * 返回值：编码后的字段字节流。
 */
export function encodeBytesField(fieldNumber: number, payload: Uint8Array): Uint8Array {
  // 0. 组合字段 Tag、载荷长度与载荷本体
  const tag = (BigInt(fieldNumber) << 3n) | 2n;
  return concatBytes(encodeVarint(tag), encodeVarint(payload.length), payload);
}

/**
 * 职责：构造单个 UTF-8 字符串类型的 Protobuf 字段字节块。
 * 思路：将字符串编码为 UTF-8 字节后复用 encodeBytesField 封装。
 * 参数：fieldNumber — 字段号；text — 字符串内容。
 * 返回值：编码后的字段字节流。
 */
export function encodeStringField(fieldNumber: number, text: string): Uint8Array {
  // 0. UTF-8 编码并包装为 wireType 2 字段
  return encodeBytesField(fieldNumber, UTF8_ENCODER.encode(text));
}
