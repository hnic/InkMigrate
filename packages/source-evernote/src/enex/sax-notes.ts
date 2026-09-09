import { createReadStream } from 'node:fs';
import sax from 'sax';

/**
 * §15.3 ENEX 流式解析：按 `<note>` 粒度切片，不把整个文件载入 DOM。
 *
 * 用 sax 的 SAXStream（Node Transform 流）驱动：背压由流机制原生处理，
 * 支持读到目标笔记后提前销毁输入流（extract 单条不必遍历全文件）。
 *
 * 两种模式：
 * - headerOnly：只捕获 title/created（scan 建轻量索引，跳过 content/resource 累积）。
 * - 全量：捕获 content/tags/note-attributes/resources（extract 单条完整解析）。
 *
 * 损坏隔离（§15.3）：SAX 出错时，此前已完整读出的笔记仍然产出；错误随结果
 * 返回，中断点之后的笔记无法可靠再同步，本实现停止并在结果中说明。
 */

/** resource 子元素中需要捕获文本的字段（§15.7.1）。 */
export interface RawResource {
  dataBase64: string;
  mime: string;
  width?: string | undefined;
  height?: string | undefined;
  fileName?: string | undefined;
  attachment?: string | undefined;
  sourceUrl?: string | undefined;
  timestamp?: string | undefined;
}

export interface RawNote {
  /** 文件内 1 基序号。 */
  ordinal: number;
  title: string;
  created?: string | undefined;
  updated?: string | undefined;
  content?: string | undefined;
  tags: string[];
  noteAttributes: Record<string, string>;
  resources: RawResource[];
}

/** ENEX 时间戳（ISO 8601 固定剖面 `yyyymmddThhmmssZ`）→ 标准 ISO 8601；非法输入返回 undefined。 */
export function enexTimeToIso(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v.trim());
  if (m === null) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)),
  );
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().replace('.000Z', 'Z');
}

interface AccumState {
  title: string;
  created?: string | undefined;
  updated?: string | undefined;
  content?: string | undefined;
  tags: string[];
  noteAttributes: Record<string, string>;
  resources: RawResource[];
}

export interface StreamNotesOptions {
  headerOnly?: boolean;
  /** 读到该序号（1 基）的笔记后停止并销毁输入流。 */
  stopAfterOrdinal?: number;
  onNote: (note: RawNote) => void;
  /** §15.3 损坏隔离：结构性损坏的笔记跳过并回调（不产出、不中断流）。 */
  onIssue?: (message: string) => void;
}

/**
 * §15.3 逐条结构校验：非严格 SAX 对未闭合标签等结构损坏是宽容的（真实导出
 * 兼容性优先），损坏表现为字段互相泄漏（如标题吞掉正文）。启发式判定：
 * - 标题含泄漏的 ENEX 结构标签（<content / <en-note / <note-attributes / <resource）。
 * - 全量模式下正文存在但缺少 <en-note 根。
 */
function structuralIssue(acc: AccumState, headerOnly: boolean): string | null {
  if (/<(\/?)(content|en-note|note-attributes|resource|created|updated)\b/i.test(acc.title)) {
    return `标题字段泄漏结构标签（title="${acc.title.slice(0, 40)}…"）`;
  }
  if (!headerOnly && acc.content !== undefined && !/<en-note\b/i.test(acc.content)) {
    return '正文缺少 <en-note> 根元素';
  }
  return null;
}

export interface StreamOutcome {
  /** SAX/IO 错误；已产出的笔记仍然有效（§15.3 损坏隔离）。 */
  error?: Error;
}

/**
 * 流式解析 ENEX 文件，逐条回调已完成的 `<note>`（同步回调）。
 * 根元素校验：非 `<en-export>` 开头的文件按错误返回（.notes 已在 scan 层拒绝，此处兜底）。
 */
export function streamNotes(path: string, opts: StreamNotesOptions): Promise<StreamOutcome> {
  const headerOnly = opts.headerOnly ?? false;
  const saxStream = sax.createStream(false, { lowercase: true, trim: false });
  const inputStream = createReadStream(path, { encoding: 'utf8' });

  let settled = false;
  let outcome: StreamOutcome = {};
  const settle = (o: StreamOutcome) => {
    if (!settled) {
      settled = true;
      outcome = o;
    }
  };

  // ── note 切片状态机 ──
  let ordinal = 0;
  let inNote = false;
  let acc: AccumState | null = null;
  let currentField: string | null = null; // 'title'|'created'|'updated'|'tag'|'content'|'res:*'|'noteattr:*'
  let textBuf = '';
  let currentResource: RawResource | null = null;
  let inNoteAttributes = false;
  let sawRoot = false;

  const appendText = (t: string) => {
    if (inNote && currentField !== null) textBuf += t;
  };

  const flushField = () => {
    if (acc === null || currentField === null) return;
    const field = currentField;
    const trimmed = textBuf.trim();
    if (field === 'title') {
      acc.title = trimmed;
    } else if (field === 'created') {
      acc.created = trimmed;
    } else if (field === 'updated') {
      acc.updated = trimmed;
    } else if (field === 'tag') {
      if (trimmed.length > 0) acc.tags.push(trimmed);
    } else if (field === 'content') {
      acc.content = textBuf; // 正文保留原始空白，规范化交给 ENML 转换
    } else if (field.startsWith('noteattr:')) {
      if (trimmed.length > 0) acc.noteAttributes[field.slice('noteattr:'.length)] = trimmed;
    } else if (currentResource !== null) {
      if (field === 'res:data') currentResource.dataBase64 = textBuf;
      else if (field === 'res:mime') currentResource.mime = trimmed;
      else if (field === 'res:width') currentResource.width = trimmed;
      else if (field === 'res:height') currentResource.height = trimmed;
      else if (field === 'res:file-name') currentResource.fileName = trimmed;
      else if (field === 'res:attachment') currentResource.attachment = trimmed;
      else if (field === 'res:source-url') currentResource.sourceUrl = trimmed;
      else if (field === 'res:timestamp') currentResource.timestamp = trimmed;
    }
    currentField = null;
    textBuf = '';
  };

  saxStream.on('opentag', (node: { name: string }) => {
    const name = node.name;
    if (!sawRoot) {
      sawRoot = name === 'en-export';
      if (!sawRoot) return; // 根不是 en-export：跳到错误路径（end 时统一判定）
    }
    if (name === 'note') {
      inNote = true;
      acc = { title: '', tags: [], noteAttributes: {}, resources: [] };
      return;
    }
    if (!inNote || acc === null) return;
    if (name === 'resource') {
      currentResource = { dataBase64: '', mime: '' };
      return;
    }
    if (name === 'note-attributes') {
      inNoteAttributes = true;
      return;
    }
    if (name === 'resource-attributes') return; // 容器，子元素单独累积
    if (currentResource !== null) {
      const fieldByTag: Record<string, string> = {
        data: 'res:data',
        mime: 'res:mime',
        width: 'res:width',
        height: 'res:height',
        'file-name': 'res:file-name',
        attachment: 'res:attachment',
        'source-url': 'res:source-url',
        timestamp: 'res:timestamp',
      };
      const f = fieldByTag[name];
      if (f !== undefined) {
        currentField = f;
        textBuf = '';
      }
      return;
    }
    if (inNoteAttributes) {
      currentField = `noteattr:${name}`;
      textBuf = '';
      return;
    }
    if (name === 'title' || name === 'created' || name === 'updated' || name === 'tag') {
      currentField = name;
      textBuf = '';
    } else if (name === 'content' && !headerOnly) {
      currentField = 'content';
      textBuf = '';
    }
  });

  saxStream.on('closetag', (name: string) => {
    if (name === 'note') {
      if (acc !== null) {
        flushField();
        ordinal += 1;
        const issue = structuralIssue(acc, headerOnly);
        if (issue !== null) {
          opts.onIssue?.(`笔记 #${ordinal} 结构损坏被隔离：${issue}`);
        } else {
          opts.onNote({
            ordinal,
            title: acc.title,
            created: acc.created,
            updated: acc.updated,
            content: acc.content,
            tags: acc.tags,
            noteAttributes: acc.noteAttributes,
            resources: headerOnly ? [] : acc.resources,
          });
        }
        if (opts.stopAfterOrdinal !== undefined && ordinal >= opts.stopAfterOrdinal) {
          settle({});
          inputStream.destroy();
        }
      }
      inNote = false;
      acc = null;
      currentResource = null;
      inNoteAttributes = false;
      currentField = null;
      textBuf = '';
      return;
    }
    if (!inNote) return;
    if (name === 'resource') {
      flushField();
      if (acc !== null && currentResource !== null && !headerOnly) {
        acc.resources.push(currentResource);
      }
      currentResource = null;
      return;
    }
    if (name === 'note-attributes') {
      flushField();
      inNoteAttributes = false;
      return;
    }
    if (name === 'resource-attributes') return;
    flushField();
  });

  saxStream.on('text', (t: string) => appendText(t));
  saxStream.on('cdata', (t: string) => appendText(t));

  return new Promise<StreamOutcome>((resolve) => {
    const done = () => resolve(outcome);
    saxStream.on('error', (e: Error) => {
      settle({ error: e });
      inputStream.destroy();
    });
    saxStream.on('end', () => {
      if (!settled) {
        settle(sawRoot ? {} : { error: new Error('not an ENEX file: root element is not <en-export>') });
      }
      done();
    });
    inputStream.on('error', (e) => {
      settle({ error: e });
      done();
    });
    // destroy() 后 close 事件兜底 resolve（end 可能不再触发）
    inputStream.on('close', () => {
      if (settled) done();
    });
    inputStream.pipe(saxStream);
  });
}
