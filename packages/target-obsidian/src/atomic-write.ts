import {
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  assertSymlinkSafe,
  assertWriteDirSafe,
  writtenFileHash,
} from '@inkmigrate/core';

/**
 * §13.10 原子写入流程（底层，不校验 frontmatter 结构）。
 *
 * 1. 在同目录创建隐藏临时文件（`.inkmigrate-<basename>.<rand>.tmp`）。
 * 2. 写入（writeFileSync 刷数据到 OS，但不 fsync——文件与 rename 的目录项都
 *    不做持久化承诺，断电后目标可能缺失或回旧版，返回哈希描述的是交付给
 *    rename 的字节而非磁盘已持久化的字节，L11 威胁模型下接受该权衡）。
 * 3. 安全校验：写前用 core assertWriteDirSafe 校验目标父目录链 + 终组件符号
 *    链接（ENOENT 安全）；写后确认 tmpPath 真实路径在 Vault 内，rename 前对
 *    目标父目录链再做一次复核。
 * 4. 原子 rename 到目标路径。
 *
 * I17: 抽出此底层函数供分片索引 / 附件复用——它们不需要 frontmatter 校验，
 * 但同样需要原子性（temp + rename），避免进程被杀留下半截损坏文件被幂等性逻辑固化。
 *
 * H3: content 既支持 string（笔记/索引），也支持 Buffer（附件二进制），使附件
 * 写入复用同一原子流程，消除附件侧半写文件风险。
 *
 * §13.2 任何目标路径都必须在解引用符号链接后再次确认位于 Vault 内。
 * 任何验证失败都不触碰目标文件，并清理临时文件。
 */
export function atomicWriteRaw(
  targetPath: string,
  content: string | Buffer,
  vaultRoot?: string,
): string {
  const isBuffer = Buffer.isBuffer(content);
  if (content.length === 0) {
    throw new Error('atomicWriteRaw: content is empty');
  }

  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });

  // §13.2 统一写入防护：core assertWriteDirSafe 专为 atomic-write 设计——校验
  // 父目录链（目标尚不存在也安全）并拒绝符号链接终组件。原先 existsSync 门控
  // 的 assertSymlinkSafe 只覆盖「目标已存在」的情况：新文件（常见场景）完全不
  // 设防，父目录已是逃逸符号链接时要等 tmp 写完才被发现（字节已落到 Vault 外）。
  // 改在 mkdir 之后、写 tmp 之前校验，tmp 永远不会写到 Vault 外。
  if (vaultRoot !== undefined) {
    assertWriteDirSafe(vaultRoot, targetPath);
  }

  const tmpPath = join(
    dir,
    `.inkmigrate-${basename(targetPath)}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    if (isBuffer) {
      writeFileSync(tmpPath, content);
    } else {
      writeFileSync(tmpPath, content, { encoding: 'utf8' });
    }

    if (vaultRoot !== undefined) {
      assertSymlinkSafe(vaultRoot, tmpPath);
      // H4: rename 前复核目标父目录链——上方校验与 rename 之间父目录被换成
      // 指向 Vault 外的符号链接时，rename 会把成品文件放到 Vault 外且仍报告
      // 成功（对 tmpPath 的校验只证明 tmp 自身位置，帮不上目标侧）。
      assertWriteDirSafe(vaultRoot, targetPath);
    }

    renameSync(tmpPath, targetPath);
  } catch (e) {
    // force 已忽略 ENOENT，无需 existsSync 预检（预检本身还是 check-then-act）
    rmSync(tmpPath, { force: true });
    throw e;
  }

  // 逻辑内容哈希：rename 原子交付的就是这份字节；内存与磁盘的静默差异由
  // verifyNote/verifyAsset 的「重读文件重算哈希」闭环兜底，不在此重复 I/O。
  return writtenFileHash(isBuffer ? content : Buffer.from(content, 'utf8'));
}

/**
 * §13.10 原子写入流程（笔记专用，校验 frontmatter 结构）。
 *
 * 在 atomicWriteRaw 之上叠加 Step 3 的 YAML frontmatter 结构验证（必须有 `---`
 * 起始与结束），笔记内容必须满足此前置条件。
 */
export function atomicWrite(
  targetPath: string,
  content: string,
  vaultRoot?: string,
): string {
  // Step 4 (early): 非空检查（先于 frontmatter 校验，空内容报 empty 而非 frontmatter 错）
  if (content.length === 0) {
    throw new Error('atomicWrite: content is empty');
  }
  // Step 3: frontmatter 结构验证
  validateFrontmatterStructure(content);
  return atomicWriteRaw(targetPath, content, vaultRoot);
}

/**
 * §13.10 Step 3：验证内容包含合法的 YAML frontmatter 起止分隔符。
 * 不做完整 YAML 解析（frontmatter.ts 已生成结构化内容；这里只防呆）。
 */
function validateFrontmatterStructure(content: string): void {
  // 容忍 BOM 与 CRLF：外部编辑器产出的合法 frontmatter 首行按 \n 切分后可能是
  // '\uFEFF---' 或 '---\r'，严格等值比较会误拒（且误报为"无结束分隔符"）。
  // 本流水线自身恒为 LF/无 BOM，此处仅提升防呆校验的健壮性，不改变现有输出。
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const isDelim = (line: string): boolean => line === '---' || line === '---\r';
  const lines = text.split('\n');
  if (lines[0] === undefined || !isDelim(lines[0])) {
    throw new Error(
      'atomicWrite: content must start with "---" frontmatter delimiter',
    );
  }
  // 找到第二个 "---"
  let closed = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && isDelim(line)) {
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
