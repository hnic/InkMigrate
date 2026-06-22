import { createHash } from 'node:crypto';

const PREFIX = 'sha256:';

function hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * §13.9 三类语义不同的哈希。算法统一为 SHA-256；它们的"身份"通过存储列与
 * 使用场景区分（`source_items.source_content_hash`、
 * `target_artifacts.target_content_hash`、`target_artifacts.written_file_hash`）。
 * 不得用同一个 `content_hash` 字段承载多种含义。
 */

/** 标准化来源正文、链接和资源清单的哈希。 */
export function sourceContentHash(content: string): string {
  return PREFIX + hex(content);
}

/** 目标适配器渲染后的逻辑内容哈希，用于判断相同输入是否产生相同目标内容。 */
export function targetContentHash(content: string): string {
  return PREFIX + hex(content);
}

/** 最终磁盘文件精确字节哈希，用于识别用户编辑或外部修改。 */
export function writtenFileHash(bytes: Buffer): string {
  return PREFIX + hex(bytes);
}
