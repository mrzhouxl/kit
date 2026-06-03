/**
 * browser/pool.ts — 浏览器实例管理
 *
 * 管理 Playwright 浏览器实例和 CDP Screencast。
 * 容器内只运行一个浏览器实例，支持多个 page。
 * 包含反自动化检测配置，使浏览器行为更接近真实用户。
 */
import { chromium, type Browser, type Page, type CDPSession } from "playwright";
import { broadcastEvent } from "../events/ws-server.js";

/** 浏览器单例及当前活跃 page */
let browser: Browser | null = null;
let currentPage: Page | null = null;
let cdpSession: CDPSession | null = null;
let screencastActive = false;

/** 真实 Chrome User-Agent（Chrome 125 on Windows 10） */
const REAL_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/**
 * 获取或启动浏览器实例
 */
async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    console.log("[Browser] 启动 Chromium（反检测模式）...");
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        // ── 反自动化检测参数 ──
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--window-size=1920,1080",
        "--start-maximized",
        // 使用 GPU 合成以通过 WebGL 指纹检测
        "--use-gl=swiftshader",
        "--enable-webgl",
        // 禁用自动化扩展提示
        "--disable-extensions",
        "--disable-default-apps",
        "--disable-component-update",
        "--no-first-run",
        "--no-default-browser-check",
        // 隐藏 headless 特征
        "--disable-background-networking",
        "--metrics-recording-only",
      ],
    });
    console.log("[Browser] Chromium 已启动");
  }
  return browser;
}

/**
 * 注入反检测脚本，在每个页面加载前执行
 * 覆盖 navigator.webdriver、navigator.plugins 等自动化指纹
 */
const STEALTH_SCRIPT = `
  // 移除 navigator.webdriver 标志
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

  // 模拟真实 Chrome 的 window.chrome 对象
  if (!window.chrome) {
    window.chrome = {
      runtime: { onConnect: { addListener: () => {} }, onMessage: { addListener: () => {} } },
      loadTimes: () => ({}),
      csi: () => ({}),
    };
  }

  // 模拟 navigator.plugins（真实 Chrome 至少有 PDF 相关插件）
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const plugins = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ];
      plugins.length = 3;
      return plugins;
    },
  });

  // 模拟 navigator.languages
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] });

  // 模拟 navigator.permissions.query
  const origQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
  if (origQuery) {
    window.navigator.permissions.query = (params) => {
      if (params.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission, onchange: null });
      }
      return origQuery(params);
    };
  }

  // 修正 WebGL 渲染器信息
  const getParam = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    if (param === 37445) return 'Intel Inc.';           // UNMASKED_VENDOR_WEBGL
    if (param === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
    return getParam.call(this, param);
  };
`;

/**
 * 获取当前活跃的 page，如果没有则创建一个
 */
export async function getPage(): Promise<Page> {
  if (currentPage && !currentPage.isClosed()) {
    return currentPage;
  }

  const b = await getBrowser();
  const context = await b.newContext({
    viewport: { width: 1920, height: 1080 },
    screen: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    userAgent: REAL_USER_AGENT,
    // 与真实浏览器一致的 Accept-Language
    extraHTTPHeaders: {
      "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });

  // 在每个页面加载前注入反检测脚本
  await context.addInitScript(STEALTH_SCRIPT);

  currentPage = await context.newPage();

  // 监听导航事件
  currentPage.on("framenavigated", (frame) => {
    if (frame === currentPage?.mainFrame()) {
      broadcastEvent({
        type: "navigate",
        url: frame.url(),
        title: "", // 导航时 title 可能还没加载
      });
    }
  });

  return currentPage;
}

/**
 * 启动 CDP Screencast，将页面画面帧实时推送给 Agent API
 */
export async function startScreencast(page: Page): Promise<void> {
  if (screencastActive && cdpSession) return;

  // 获取 CDP Session
  const context = page.context();
  cdpSession = await context.newCDPSession(page);

  // 监听帧事件
  cdpSession.on("Page.screencastFrame", async (event: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    broadcastEvent({
      type: "screencast",
      frame: event.data,
      url: page.url(),
      timestamp: event.metadata.timestamp ?? Date.now(),
    });
    // 确认收到帧，否则 CDP 会暂停推送
    try {
      await cdpSession!.send("Page.screencastFrameAck", { sessionId: event.sessionId });
    } catch {
      // page 可能已关闭
    }
  });

  // 开始录制
  await cdpSession.send("Page.startScreencast", {
    format: "jpeg",
    quality: 50,
    maxWidth: 1920,
    maxHeight: 1080,
    everyNthFrame: 3, // 每 3 帧采样一次，降低带宽
  });

  screencastActive = true;
  console.log("[Browser] Screencast 已启动");
}

/**
 * 停止 Screencast
 */
export async function stopScreencast(): Promise<void> {
  if (cdpSession && screencastActive) {
    try {
      await cdpSession.send("Page.stopScreencast");
    } catch {
      // 忽略
    }
    screencastActive = false;
    console.log("[Browser] Screencast 已停止");
  }
}

/**
 * 对当前页面截图，返回 base64 JPEG
 */
export async function takeScreenshot(page: Page): Promise<string> {
  const buffer = await page.screenshot({ type: "jpeg", quality: 70 });
  return buffer.toString("base64");
}

/**
 * 关闭浏览器实例（容器退出时调用）
 */
export async function closeBrowser(): Promise<void> {
  await stopScreencast();
  if (currentPage && !currentPage.isClosed()) {
    await currentPage.context().close();
  }
  if (browser) {
    await browser.close();
    browser = null;
  }
  currentPage = null;
  cdpSession = null;
  console.log("[Browser] 已关闭");
}
