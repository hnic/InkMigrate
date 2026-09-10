import { computeFingerprint } from '@inkmigrate/core';

/**
 * §15.4 笔记身份。
 *
 * 优先级：稳定 GUID → Evernote App Link → SHA-256(export-file-hash + note-ordinal +
 * title + createdAt)。标准 ENEX（evernote-export3.dtd）不含 GUID；evernote-backup
 * `export --add-guid/--add-metadata` 会在每条笔记附带 `<guid>`，此时走第 1 级
 * （跨导出稳定：同一账号多次导出指纹不变）。App Link 仅在 note-attributes/
 * source-url 恰好是含笔记 GUID 的 evernote:// 链接时可用；默认走第 3 级。
 * 标题永不作为唯一主键。
 */

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface NoteIdentityInput {
  /** §15.4 第 1 优先级：稳定 GUID（evernote-backup --add-guid 扩展）。 */
  guid?: string | undefined;
  /** ENEX 文件内容 SHA-256（hex）。 */
  fileSha256: string;
  /** 文件内 1 基序号。 */
  ordinal: number;
  title: string;
  /** 已规范化的 ISO 创建时间；缺失传 undefined。 */
  createdIso?: string | undefined;
  /** §15.4 第 2 优先级：可解析的 evernote:// App Link。 */
  appLink?: string | undefined;
  /** externalId 需要 notebook 维度参与（同实例多文件序号隔离）。 */
  fileBaseName: string;
}

export interface NoteIdentity {
  externalId: string;
  fingerprint: string;
}

export function buildNoteIdentity(i: NoteIdentityInput): NoteIdentity {
  // 归一常见包裹形态（空白/{...} 大括号/urn:uuid: 前缀）再校验：
  // 否则这些非规范 GUID 会静默降级到第 3 级，破坏文档化的跨导出稳定身份
  const guidRaw = i.guid
    ?.trim()
    .replace(/^\{|\}$/g, '')
    .replace(/^urn:uuid:/i, '');
  if (guidRaw !== undefined && GUID_RE.test(guidRaw)) {
    const guid = guidRaw.toLowerCase();
    return {
      externalId: `evernote-guid:${guid}`,
      fingerprint: computeFingerprint({ raw: `guid:${guid}` }),
    };
  }
  // App Link 优先（§15.4）：仅接受可解析出笔记 GUID 的 evernote:// 链接
  // （/view/<user>/<shard>/<guid>/<guid>/ 或 /l/<shard>/<guid>/ 形态）。
  // source-url 是用户可编辑字段且复制笔记时原样拷贝：裸 evernote://、action
  // 短链或任意用户输入的 evernote://whatever 不是 per-note 稳定标识，多条笔记
  // 携带同值会折叠成同一 externalId 造成静默去重——不得冒充第 2 级身份。
  // 校验通过后再统一小写（同一链接不因大小写/空白差异分裂身份）。
  const trimmedAppLink = i.appLink?.trim();
  if (trimmedAppLink !== undefined && /^evernote:\/\//i.test(trimmedAppLink)) {
    const hasGuidSeg = trimmedAppLink
      .replace(/^evernote:\/\//i, '')
      .split('/')
      .some((seg) => GUID_RE.test(seg));
    if (hasGuidSeg) {
      const appLink = trimmedAppLink.toLowerCase();
      return {
        externalId: `evernote-link:${appLink}`,
        // 与第 1 级同理：externalId 跨导出稳定 → 指纹同样不含易变的文件哈希，
        // 否则重复导出时 externalId 相同而指纹变化，去重/已验证跳过失效
        fingerprint: computeFingerprint({ raw: `link:${appLink}` }),
      };
    }
  }
  // 否则 file#ordinal（数据库 external_id 在来源实例内唯一）。
  // 注意：externalId 含 ordinal，同文件重新导出（插入/删除笔记）会使序号漂移，
  // 既有 externalId 可能指向另一条笔记——按 externalId 更新记录时需警惕错关联
  //（§15.4 已声明的取舍：标准 ENEX 无 per-note 稳定键可用）。
  // 文件名中的 # 转义为 %23，保持 file#ordinal 拼接约定可解析（无 # 文件名不受影响）。
  const externalId = `enex:${i.fileBaseName.replace(/#/g, '%23')}#${i.ordinal}`;
  const raw = [i.fileSha256, String(i.ordinal), i.title, i.createdIso ?? ''].join('\0');
  return {
    externalId,
    fingerprint: computeFingerprint({ raw }),
  };
}
