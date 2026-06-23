import {
  mkdirSync,
  writeFileSync,
  renameSync,
  existsSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * §13.10 原子写入流程：
 *
 * 1. 在同目录创建隐藏临时文件（`.inkmigrate-<basename>.<rand>.tmp`）。
 * 2. 写入（writeFileSync 在 Node 上默认 flush 元数据）。
 * 3. 解析 YAML frontmatter 与 Markdown 基础结构（必须有 `---` 起始与结束）。
 * 4. 验证非空。
 * 5. 原子 rename 到目标路径。
 *
 * 任何验证失败都不触碰目标文件，并清理临时文件。
 */
export function atomicWrite(targetPath: string, content: string): void {
  // Step 4 (early): 非空检查
  if (content.length === 0) {
    throw new Error('atomicWrite: content is empty');
  }

  // Step 3: frontmatter 结构验证
  validateFrontmatterStructure(content);

  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });

  const tmpPath = join(
    dir,
    `.inkmigrate-${basename(targetPath)}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    // Step 2: 写入临时文件
    writeFileSync(tmpPath, content, { encoding: 'utf8' });

    // Step 5: 原子 rename
    renameSync(tmpPath, targetPath);
  } catch (e) {
    // 清理临时文件（如还在）
    if (existsSync(tmpPath)) rmSync(tmpPath, { force: true });
    throw e;
  }
}

/**
 * §13.10 Step 3：验证内容包含合法的 YAML frontmatter 起止分隔符。
 * 不做完整 YAML 解析（frontmatter.ts 已生成结构化内容；这里只防呆）。
 */
function validateFrontmatterStructure(content: string): void {
  const lines = content.split('\n');
  if (lines[0] !== '---') {
    throw new Error(
      'atomicWrite: content must start with "---" frontmatter delimiter',
    );
  }
  // 找到第二个 "---"
  let closed = false;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      closed = true;
      break;
    }
  }
  if (!closed) {
    throw new Error(
      'atomicWrite: content has opening "---" but no closing "---" delimiter',
    );
  }
}

/** §13.10 内部读取辅助（用于覆盖前读取已有文件计算 written_file_hash）。 */
export function readTargetIfExists(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return readFileSync(path, 'utf8');
}
