/**
 * §13.9 三类语义不同的哈希。算法统一为 SHA-256；它们的"身份"通过存储列与
 * 使用场景区分（`source_items.source_content_hash`、
 * `target_artifacts.target_content_hash`、`target_artifacts.written_file_hash`）。
 * 不得用同一个 `content_hash` 字段承载多种含义。
 */
import { createHash } from 'node:crypto';

const PREFIX = 'sha256:';

function hex(input: string | Buffer): string {
  const h = createHash('sha256');
  // 字符串显式按 UTF-8 编码（而非依赖默认值）：writtenFileHash 与字符串哈希
  // 仅在「写入路径保证 UTF-8 / LF / 无 BOM」时才可比，编码是这一可比性的前提。
  if (typeof input === 'string') h.update(input, 'utf8');
  else h.update(input);
  return h.digest('hex');
}

/**
 * 来源正文、链接和资源清单的哈希。输入必须已由调用方完成标准化（空白、行尾、
 * 编码）——本函数不做任何归一化，直接对输入做 UTF-8 SHA-256；调用方纪律是
 * §13.9「哈希可靠检测内容变化」的前提。
 */
export function sourceContentHash(content: string): string {
  return PREFIX + hex(content);
}

/**
 * 目标适配器渲染后的逻辑内容哈希，用于判断相同输入是否产生相同目标内容。
 * 与 sourceContentHash 相同：不做归一化，标准化责任在调用方。
 */
export function targetContentHash(content: string): string {
  return PREFIX + hex(content);
}

/**
 * 最终磁盘文件精确字节哈希，用于识别用户编辑或外部修改。
 *
 * 与 sourceContentHash / targetContentHash 仅在「写入/读取路径保证
 * UTF-8 / LF / 无 BOM」时才逐字节可比（编码前提见 hex() 说明）；跨类型
 * 比较前请确认该前提成立。
 */
export function writtenFileHash(bytes: Buffer): string {
  return PREFIX + hex(bytes);
}
