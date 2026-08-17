

const { chromium } = require('playwright');
const fs = require('node:fs');

// 检查认证文件是否存在
if (!fs.existsSync('auth.json')) {
  console.error("错误：找不到 auth.json 文件。");
  console.error("请先运行 node setupAuth.js 来生成认证文件。");
  process.exit(1);
}

(async () => {
  // 启动无头浏览器并加载登录状态
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ]
  });
  const context = await browser.newContext({
    storageState: 'auth.json',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });
  const page = await context.newPage();

  try {
    console.log("1. 导航到掘金首页...");
    await page.goto("https://juejin.cn/user/center/signin", { timeout: 60000 });
    await page.waitForTimeout(5000); // 增加等待时间

    // --- 步骤 2: 执行签到 ---
    console.log("\n2. 尝试进行签到...");
    try {
      // 先检查页面是否正确加载
      console.log("  - 当前页面URL:", page.url());

      // 等待页面完全加载
      await page.waitForLoadState('networkidle');

      // 监听签到相关网络请求，用于诊断点击是否真正触发了请求
      const checkInResponses = [];
      page.on('response', async (res) => {
        if (res.url().includes('growth_api')) {
          let body = '';
          try { body = (await res.text()).slice(0, 300); } catch {}
          console.log(`  [网络] ${res.request().method()} ${res.url()} -> ${res.status()} ${body}`);
          checkInResponses.push(res.url());
        }
      });
      page.on('console', msg => {
        if (msg.type() === 'error') console.log(`  [页面错误] ${msg.text().slice(0, 200)}`);
      });

      // 尝试等待签到相关元素出现
      try {
        await page.waitForSelector('text=签到', { timeout: 10000 });
        console.log("  - 找到签到相关文字");
      } catch (e) {
        console.log("  - 10秒内未找到签到相关文字，可能已经签到过了: ", e);
      }

      // 打印页面标题和部分内容
      console.log("  - 页面标题:", await page.title());
      const bodyText = await page.locator('body').textContent();
      console.log("  - 页面是否包含'掘金':", bodyText.includes('掘金'));
      console.log("  - 页面是否包含'签到':", bodyText.includes('签到'));

      // 添加更多调试信息
      console.log("  - 页面完整HTML长度:", (await page.content()).length);
      await page.screenshot({ path: 'debug-signin.png', fullPage: true });

      // 页面已加载，重新检查签到按钮
      const signInSelectors = [
        '.signin.btn',
        'button.signin',
        'button:has-text("立即签到")',
        'button:has-text("签到")'
      ];

      for (const selector of signInSelectors) {
        const element = page.locator(selector);
        const count = await element.count();
        const isVisible = count > 0 ? await element.isVisible() : false;
        console.log(`  - 选择器 "${selector}": 数量=${count}, 可见=${isVisible}`);

        if (count > 0) {
          const text = await element.textContent();
          console.log(`    文本内容: "${text}"`);
        }
      }

      // 尝试点击签到按钮并验证是否真正生效
      // 判定依据（任一满足即算成功）：
      //   a. 按钮文字变为"已签到"
      //   b. 页面出现签到结果弹窗
      //   c. 监听到 check_in 相关网络请求返回成功
      const checkInButton = page.locator('.signin.btn');
      const fallbackButton = page.locator('button:has-text("签到")');
      const target = (await checkInButton.count() > 0) ? checkInButton : fallbackButton;

      async function checkSignedIn(label) {
        const btnText = (await target.textContent().catch(() => '') || '').trim();
        const modal = page.locator('.byte-modal, .modal, [class*="signin-result"], [class*="code-calender"]');
        const modalVisible = await modal.first().isVisible().catch(() => false);
        const apiFired = checkInResponses.some(u => u.includes('check_in'));
        console.log(`  - [${label}] 按钮文字="${btnText}", 弹窗可见=${modalVisible}, 签到请求已发出=${apiFired}`);
        await page.screenshot({ path: `debug-after-${label}.png`, fullPage: true });
        return btnText.includes('已签到') || modalVisible || apiFired;
      }

      if (await target.count() > 0) {
        await target.click();
        console.log("  - 已点击签到按钮");
        await page.waitForTimeout(3000);

        if (await checkSignedIn('click')) {
          console.log("  - 签到成功（Playwright click）");
        } else {
          console.log("  - 点击未生效，尝试 DOM 原生 click()...");
          await target.evaluate(el => el.click());
          await page.waitForTimeout(3000);

          if (await checkSignedIn('domclick')) {
            console.log("  - 签到成功（DOM click）");
          } else {
            console.log("  - 仍未生效，尝试模拟完整鼠标事件序列...");
            await target.evaluate(el => {
              const rect = el.getBoundingClientRect();
              const cx = rect.left + rect.width / 2;
              const cy = rect.top + rect.height / 2;
              const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
              el.dispatchEvent(new MouseEvent('mousedown', opts));
              el.dispatchEvent(new MouseEvent('mouseup', opts));
              el.dispatchEvent(new MouseEvent('click', opts));
            });
            await page.waitForTimeout(3000);

            if (await checkSignedIn('mouse')) {
              console.log("  - 签到成功（模拟鼠标事件）");
            } else {
              console.log("  - 签到仍未成功，请查看 debug-after-mouse.png 与上方 [网络] 日志");
            }
          }
        }
      } else {
        console.log("  - 未找到可点击的签到按钮");
      }
    } catch (e) {
      if (e.name === 'TimeoutError') {
        console.log("  - 等待签到成功弹窗超时，可能已经签到过了或UI已更改。");
      } else {
        console.log(`  - 签到过程中出现错误: ${e.message}`);
      }
    }

    // --- 步骤 3: 执行抽奖 ---
    console.log("\n3. 尝试进行抽奖...");
    try {
      console.log("  - 导航到抽奖页面...");
      await page.goto("https://juejin.cn/user/center/lottery", { timeout: 60000 });
      await page.waitForTimeout(3000);

      // 找到“免费抽奖”按钮并点击
      const drawButton = page.locator('#turntable-item-0');
      if (await drawButton.isVisible()) {
        await drawButton.click();
        console.log("  - 点击了抽奖按钮。");
        // 等待抽奖结果弹窗
        await page.waitForSelector('.lottery-modal .byte-modal__body', { timeout: 10000 });
        const resultText = await page.locator('.lottery-modal .byte-modal__body').textContent();
        console.log(`  - 抽奖完成！获得: ${resultText.trim()}`);
      } else {
        console.log("  - 未找到抽奖按钮，可能没有抽奖次数或UI已更改。");
      }
    } catch (e) {
      if (e.name === 'TimeoutError') {
        console.log("  - 等待抽奖结果超时或未找到抽奖按钮。");
      } else {
        console.log(`  - 抽奖过程中出现错误: ${e.message}`);
      }
    }

  } finally {
    console.log("\n任务执行完毕，关闭浏览器。");
    await browser.close();
  }
})();
