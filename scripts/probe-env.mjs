/**
 * Environment facts the game branches on. Several bugs here were "browser specific" only because a
 * feature-detection heuristic (maxTouchPoints, pointer lock support) differs per engine/browser —
 * so measure them here, in both engines, rather than reasoning about it.
 */
import { chromium, webkit } from 'playwright-core';
for (const [name, b] of [['chrome', chromium], ['webkit', webkit]]) {
  const browser = await (name === 'chrome'
    ? b.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
    : b.launch());
  const page = await (await browser.newContext()).newPage();
  await page.goto('about:blank');
  console.log(name.padEnd(7), await page.evaluate(() => JSON.stringify({
    maxTouchPoints: navigator.maxTouchPoints,
    ontouchstart: 'ontouchstart' in window,
    TouchEvent: 'TouchEvent' in window,
    PointerEvent: 'PointerEvent' in window,
    requestPointerLock: 'requestPointerLock' in Element.prototype,
    lockTakesOptions: Element.prototype.requestPointerLock.length,
    gamepads: (navigator.getGamepads?.() ?? []).filter(Boolean).length,
    dpr: devicePixelRatio,
  })));
  await browser.close();
}
