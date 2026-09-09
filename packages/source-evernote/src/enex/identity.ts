import { computeFingerprint } from '@inkmigrate/core';

/**
 * §15.4 笔记身份。
 *
 * 优先级：稳定 GUID → Evernote App Link → SHA-256(export-file-hash + note-ordinal +
 * title + createdAt)。ENEX（evernote-export3.dtd）的 note 元素不含 GUID，
 * App Link 仅在 note-attributes/source-url 恰好是 evernote:// 链接时可用；
 * 因此默认走第 3 级（确定性：同一文件集重扫指纹不变）。
 * 标题永不作为唯一主键。
 */

export interface NoteIdentityInput {
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
  // App Link 优先（§15.4）；否则 file#ordinal（数据库 external_id 在来源实例内唯一）
  const externalId =
    i.appLink !== undefined && i.appLink.length > 0
      ? `evernote-link:${i.appLink}`
      : `enex:${i.fileBaseName}#${i.ordinal}`;
  const raw = [i.fileSha256, String(i.ordinal), i.title, i.createdIso ?? ''].join('\0');
  return {
    externalId,
    fingerprint: computeFingerprint({ raw }),
  };
}
