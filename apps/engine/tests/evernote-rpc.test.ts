import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIST = resolve(__dirname, '..', 'dist', 'index.js');
const FIXTURES = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'packages',
  'source-evernote',
  'tests',
  'fixtures',
  'evernote',
);

/**
 * §15 GUI/Engine 接线（设计文档 T4）：Evernote 文件源经真实 JSON-RPC 全链路。
 * spawn engine 子进程（stdin/stdout JSON-RPC），覆盖 schema 校验 → 分派 → 迁移。
 */
describe('engine RPC: evernote file source', () => {
  let proc: ChildProcess;
  let buffer = '';
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const notifications: unknown[] = [];
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'inkmigrate-engine-rpc-'));
    proc = spawn(process.execPath, [ENGINE_DIST], { stdio: ['pipe', 'pipe', 'inherit'] });
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.length === 0) continue;
        let msg: { id?: number; result?: unknown; error?: { message: string }; method?: string };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.error !== undefined) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        } else if (msg.method !== undefined) {
          notifications.push(msg);
        }
      }
    });
    await new Promise<void>((resolveStartup) => {
      // engine 启动即绪（stdin 循环无 ready 信号，写一条 RPC 探活）
      call('auth.status', { source: 'probe', stateDir: root }).then(
        () => resolveStartup(),
        () => resolveStartup(),
      );
    });
  }, 30_000);

  afterAll(async () => {
    proc.kill();
    rmSync(root, { recursive: true, force: true });
  });

  function call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = nextId++;
    const req = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolveCall, rejectCall) => {
      pending.set(id, { resolve: resolveCall, reject: rejectCall });
      proc.stdin!.write(req + '\n');
    });
  }

  function setupWorkspace(): { stateDir: string; vaultDir: string; configPath: string } {
    const stateDir = join(root, 'state');
    const vaultDir = join(root, 'vault');
    const importsDir = join(root, 'imports', 'evernote');
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(vaultDir, { recursive: true });
    mkdirSync(importsDir, { recursive: true });
    for (const f of ['basic.enex', 'interlinks.enex', 'resources-named.enex']) {
      cpSync(join(FIXTURES, f), join(importsDir, f));
    }
    const configPath = join(root, 'inkmigrate.yaml');
    writeFileSync(
      configPath,
      [
        'version: 1',
        'workspace:',
        '  stateDir: ".inkmigrate"',
        '  reportsDir: "reports"',
        'sources:',
        '  - id: "evernote-archive"',
        '    adapter: "evernote"',
        '    enabled: true',
        '    config:',
        '      inputPaths: ["imports/evernote"]',
        '      formats: ["enex"]',
        'targets:',
        '  - id: "personal-vault"',
        '    adapter: "obsidian"',
        '    enabled: true',
        '    config: {}',
        '',
      ].join('\n'),
    );
    return { stateDir, vaultDir, configPath };
  }

  it('scan.preview 返回条目数与笔记本分布（不写库）', async () => {
    const w = setupWorkspace();
    const r = (await call('scan.preview', {
      source: 'evernote-archive',
      stateDir: w.stateDir,
      configPath: w.configPath,
    })) as { uniqueItems: number; byNotebook: Record<string, number>; issues: string[] };
    expect(r.uniqueItems).toBe(5); // basic 2 + interlinks 2 + resources-named 1
    expect(r.byNotebook['basic']).toBe(2);
    expect(r.byNotebook['interlinks']).toBe(2);
    expect(r.byNotebook['resources-named']).toBe(1);
    // §15.5：无 Stack 的导出文件产生"无法自动还原"提示（进报告）
    expect(r.issues).toHaveLength(3);
    expect(r.issues.join('\n')).toContain('basic.enex：无 Stack 信息');
    // 不写库：stateDir 无数据库文件（scan.preview 是纯读）
    expect(existsSync(join(w.stateDir, 'inkmigrate.sqlite'))).toBe(false);
  }, 30_000);

  it('scan.preview 对未配置的来源返回明确错误', async () => {
    const w = setupWorkspace();
    await expect(
      call('scan.preview', {
        source: 'no-such-source',
        stateDir: w.stateDir,
        configPath: w.configPath,
      }),
    ).rejects.toThrow(/未找到启用的 evernote 来源/);
  }, 30_000);

  it('migrate.start 全链路：分派文件源并写入 Vault，对账通过', async () => {
    const w = setupWorkspace();
    const r = (await call('migrate.start', {
      source: 'evernote-archive',
      target: 'personal-vault',
      stateDir: w.stateDir,
      vaultPath: w.vaultDir,
      configPath: w.configPath,
    })) as { status: string; scanCount: number; reconciliationOk: boolean; jobId: string };
    expect(r.status).toBe('completed');
    expect(r.scanCount).toBe(5);
    expect(r.reconciliationOk).toBe(true);

    // §13.3 目录结构 + 内部链接 wikilink（GUI 侧真实产物）
    const archive = join(w.vaultDir, 'Imports/InkMigrate/evernote-archive');
    expect(existsSync(archive)).toBe(true);
    const mdFiles: string[] = [];
    const walk = (d: string, depth = 0) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, e.name);
        if (e.isDirectory() && e.name !== '_索引') walk(full, depth + 1);
        else if (e.name.endsWith('.md') && depth >= 1) mdFiles.push(readFileSync(full, 'utf8'));
      }
    };
    walk(archive);
    expect(mdFiles).toHaveLength(5);
    expect(mdFiles.some((c) => c.includes('笔记甲'))).toBe(true);
    expect(mdFiles.some((c) => c.includes('[[笔记乙-'))).toBe(true);
    // 附件按原名落盘
    const attach = join(w.vaultDir, 'Attachments/InkMigrate/evernote-archive');
    expect(existsSync(join(attach))).toBe(true);
  }, 60_000);

  it('migrate.start 无 configPath 时维持 toutiao 行为（缺 Profile 报既有错误）', async () => {
    const w = setupWorkspace();
    await expect(
      call('migrate.start', {
        source: 'evernote-archive',
        target: 'personal-vault',
        stateDir: w.stateDir,
        vaultPath: w.vaultDir,
      }),
    ).rejects.toThrow(/Profile 不存在/);
  }, 30_000);
});
