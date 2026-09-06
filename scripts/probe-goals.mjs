/** UI-6 probe: the goal card must fade out by itself and return only when relevant. */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
const PORT = 4403;
const BASE = `http://localhost:${PORT}`;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
const page = await (await browser.newContext({ viewport: { width: 1000, height: 640 } })).newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const card = () => page.evaluate(() => {
  const t = document.getElementById('milestone-tracker');
  return { hidden: t.classList.contains('hidden'), faded: t.classList.contains('faded'), opacity: Number(getComputedStyle(t).opacity), title: t.querySelector('.milestone-title')?.textContent ?? '', screen: window.webcraft?.game?.screen, focus: document.activeElement?.id || document.activeElement?.tagName };
});
const st = async (label) => { const c = await card(); console.log(label.padEnd(22), JSON.stringify(c)); return c; };

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.click('#btn-worlds');
await page.waitForSelector('#screen-worlds.active');
await page.fill('#new-name', 'Goals');
await page.click('#btn-create');
await page.waitForFunction(`(() => { const g = window.webcraft?.game; return !!g && g.running && g.screen === 'none'; })()`, null, { timeout: 60000 });
await page.mouse.click(500, 320);
await page.waitForTimeout(800);
await st('at world start');
await page.waitForTimeout(14000);
await st('after 14 s idle');
await page.keyboard.press('KeyE');
await page.waitForFunction(`(() => !!document.querySelector('#panel-inventory.active'))()`, null, { timeout: 5000 });
await st('inventory open');
await page.keyboard.press('KeyE');
await page.waitForFunction(async () => !document.querySelector('#panel-inventory.active'), null, { timeout: 5000 });
await page.waitForTimeout(700);
await st('panel closed');
await page.keyboard.press('Tab');
await page.waitForTimeout(600);
await st('Tab (pin)');
await page.waitForTimeout(4000);
await st('pin + 4 s');
await page.keyboard.press('Tab');
await page.waitForTimeout(5200);
await st('Tab (unpin) + 5 s');
await browser.close();
server.kill('SIGKILL');
