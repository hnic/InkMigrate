import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';

  /**
   * §12.2 浏览器会话配置。Profile 路径由调用方通过 profile.ts 计算后传入。
   */
  export interface BrowserSessionConfig {
    /** 工具专用持久化 Profile 目录（§12.2）。 */
    profileDir: string;
    /**
     * 是否无头模式；默认 false。
     *
     * 【2026-06-27 实测确认】头条【收藏/token 端点】对 headless 做反爬：同一 profile
     * （带 cookie）下，有头拿到 67KB 完整 SPA，headless 仅拿 39 字节空 HTML 骨架。
     * 已排除两个混淆变量：
     *   1. cookie——带 cookie 的 headless 仍 39B；
     *   2. Chromium 指纹——headless + 系统 Chrome（channel:'chrome'）仍 39B。
     * 头条首页在 headless 下可正常访问，拦截只发生在收藏这类高价值端点。Playwright
     * 默认即 new-headless（new-headless 不够隐蔽）。
     * 唯一未测的路径是 stealth（抹 navigator.webdriver 等），但连系统真 Chrome 的
     * headless 都被拦，强烈暗示检测在 headless 运行模式底层而非 JS 指纹层——stealth
     * 成功概率存疑。综上 scan/migrate/cleanup 全部默认有头以保证可用。
     * 复现/对照工具见 scripts/probe-headless-anti-scrape.ts。
     */
    headless?: boolean;
  /** 浏览器 locale，默认 zh-CN。 */
  locale?: string;
  /** 时区 ID，默认 Asia/Shanghai。 */
  timezoneId?: string;
  /** 视口大小。 */
  viewport?: { width: number; height: number };
  /**
   * close() 等待浏览器关闭的上限毫秒数，默认 15000。超时则放弃等待让调用方
   * （如 cleanup RPC handler）尽快返回；残留浏览器进程由 Playwright/系统回收。
   */
  closeTimeoutMs?: number;
}

/**
 * §12.2 Playwright 持久化浏览器会话管理器。
 *
 * 封装 chromium.launchPersistentContext，提供 launch/newPage/close 生命周期。
 * Profile 位于工具专用目录，与用户日常 Chrome Profile 隔离（§12.2 禁令）。
 *
 * 设计决策：adapter-owned lifecycle。适配器工厂创建本会话实例，
 * prepare() 调用 launch()，close() 调用本类的 close()。
 * 不通过 AdapterContext 传递浏览器句柄（context 形状不可变）。
 */
export class ToutiaoBrowserSession {
  private context: BrowserContext | undefined;
  /** 在飞的 launch 任务；用于并发 launch 去重与 close 期间的串行化。 */
  private launchPromise: Promise<void> | undefined;
  /**
   * close() 执行窗口标志（同步置位/复位，非终态）：置位期间到达或在飞的
   * launch 都是"注定失败"的——要么 context 会被 close 接管清理，要么撞
   * 同一 profileDir 的 SingletonLock。非终态是为了支持 adapter 的 recycle
   * （同实例 close() 完成后再 launch()）。
   */
  private closing = false;

  constructor(private readonly config: BrowserSessionConfig) {}

  async launch(): Promise<void> {
    // close() 正在进行：此时起浏览器要么被 close 接管清理、要么与旧 Chromium
    // 抢 profileDir 的 SingletonLock 稀疏失败，快速失败不报告成功
    if (this.closing) {
      throw new Error('ToutiaoBrowserSession is closing; launch rejected');
    }
    if (this.context !== undefined) return;
    // 复用在飞的 launch：guard 无法覆盖 await 窗口，并发调用会各起一个浏览器，
    // 第二次赋值覆盖 this.context 后第一个 Chromium 进程就再无句柄可关。
    this.launchPromise ??= (async () => {
      const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
        headless: this.config.headless ?? false,
        locale: this.config.locale ?? 'zh-CN',
        timezoneId: this.config.timezoneId ?? 'Asia/Shanghai',
      };
      const viewport = this.config.viewport ?? { width: 1440, height: 1000 };
      launchOptions.viewport = viewport;
      const ctx = await chromium.launchPersistentContext(
        this.config.profileDir,
        launchOptions,
      );
      this.context = ctx;
      // 有头模式下用户直接关掉浏览器窗口时同步清句柄：newPage() 能报出明确的
      // 'not launched' 错误而非晦涩的 'Target closed'，launch() 也可重新拉起
      //（否则 ??= 守卫会拿到已 fulfilled 的旧 launchPromise 立即"成功"返回，
      // 而 context 实际已死）。本类自身 close() 先清 this.context 再关 ctx，
      // 触发时只是重复置 undefined，无副作用。守卫 this.context === ctx：
      // close() 超时放弃等待后，旧 context 的 close 事件可能晚于下一次
      // launch()（recycle）到达，不能误清新 context 的句柄。
      ctx.on('close', () => {
        if (this.context === ctx) {
          this.context = undefined;
          this.launchPromise = undefined;
        }
      });
    })().catch((err: unknown) => {
      // 失败后清除，允许后续 launch() 重试
      this.launchPromise = undefined;
      throw err;
    });
    await this.launchPromise;
    // close() 在本 launch 落定前已同步置位 closing 并接管清理：不能向调用方
    // 报告成功，否则调用方拿着已死/即将被关的会话去 newPage()（'Target closed'）
    if (this.closing) {
      throw new Error('ToutiaoBrowserSession was closed while launching');
    }
  }

  async newPage(): Promise<Page> {
    if (this.context === undefined) {
      throw new Error('ToutiaoBrowserSession not launched; call launch() first');
    }
    return this.context.newPage();
  }

  async close(): Promise<void> {
    // 同步置位 closing：让并发到达的 launch() 立即失败、让在飞 launch 的
    // 调用方在落定后也不会拿到"成功"。finally 复位以支持 adapter 的
    // recycle（close() 完成后同实例重新 launch()）。
    this.closing = true;
    try {
      // launch 在飞时先等它落定再关闭：否则 close() 看到 context === undefined 直接
      // 返回，随后 launch 完成会把一个全新 context 赋给已经"关闭"的会话（泄漏浏览器）
      if (this.launchPromise !== undefined) {
        await this.launchPromise.catch(() => {
          /* launch 失败则无 context 可关 */
        });
        this.launchPromise = undefined;
      }
      const ctx = this.context;
      this.context = undefined;
      if (ctx !== undefined) {
        // ctx.close() 无超时参数，长时间有头运行后 Chromium 关闭可能卡死
        //（残留页面/渲染进程）。一旦永久挂起，cleanup RPC handler 的 finally 永不返回，
        //前端 busy 永不复位 → 所有按钮灰着点不动。这里给一个上限：超时则放弃等待，
        //让 RPC 尽快释放；浏览器进程由 Playwright/系统最终回收。
        const CLOSE_TIMEOUT_MS = this.config.closeTimeoutMs ?? 15_000;
        let timedOut = false;
        let timerId: ReturnType<typeof setTimeout> | undefined;
        const timer = new Promise<void>((resolve) => {
          timerId = setTimeout(() => {
            timedOut = true;
            resolve();
          }, CLOSE_TIMEOUT_MS);
        });
        try {
          // catch 直接挂在 close promise 上（timer 永不 reject）：race 超时先
          // settle 后，晚到的 close rejection 不会再进入 race 的 .catch，
          // 挂在这里才能观测到"挂起后迟到失败"这一最常见失败模式
          const closing = ctx
            .close({ reason: 'browser-session close timeout' })
            .catch((err: unknown) => {
              // close 失败不阻塞（会话即将被丢弃），但记录日志便于排查
              //（如 Windows 上 profile 锁残留、磁盘错误导致的静默浏览器泄漏）
              console.warn('[toutiao-browser-session] context close failed:', err);
            });
          await Promise.race([closing, timer]);
        } finally {
          // close 先完成也要清掉定时器：残留 timer 会把 Node 事件循环拖住最多 15s
          clearTimeout(timerId);
        }
        // R16: 超时后 ctx.close() 仍在后台挂起，浏览器进程可能泄漏。
        // Playwright 公开 API 不暴露 browser PID，无法直接 process.kill。
        // 兜底：遍历并强制关闭所有残留 page，触发浏览器释放大部分资源（渲染进程）。
        // 若 ctx 已不可用（已 close）则忽略错误。
        if (timedOut) {
          try {
            const pages = ctx.pages();
            // 不 await：page.close() 走同一条（可能已卡死的）连接，await 会让 close()
            // 远超 CLOSE_TIMEOUT_MS 上限；会话即将被丢弃，触发后不再等待
            void Promise.allSettled(pages.map((p) => p.close({ runBeforeUnload: false })));
          } catch {
            /* ctx 已关闭或不可用，忽略 */
          }
        }
      }
    } finally {
      this.closing = false;
    }
  }

  /**
   * 会话当前是否已持有 context。注意两个盲区：
   * - launch() 在飞期间为 false（context 要等 launchPersistentContext 落定才赋值）；
   * - close() 超时放弃等待后，浏览器进程可能仍存活（此值已为 false）。
   * 调用方应以 launch()/close() 的 Promise 结果为准，而非轮询本 getter。
   */
  get launched(): boolean {
    return this.context !== undefined;
  }
}
