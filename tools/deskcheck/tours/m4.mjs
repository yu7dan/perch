// M4 导览：应用启动台 / 应用块（别的程序自己的窗口贴在块上）/ 网页块（Perch 自己的 WebView2 窗口）/ 让位与收起。
// 贴着的真窗口不在主窗口的录像里，由 tour.mjs 的「外来窗口轨」叠上去（网页截它自己那一页，应用用 PrintWindow 画）。
// 前提：测试实例；开录前台面上的块都收起来、没有网页块 / 应用块。用计算器演示（打开后由这一块关掉）。
export default async function (t) {
  const { sleep } = t;
  const waitFor = async (js, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await t.ev(js)) return true; await sleep(300); } return false; };

  await t.say("M4 · 应用：Dock 上这一颗是启动台 —— 这台电脑「开始菜单」里的应用，都是它们自己的图标");
  await t.clickSel('[data-dock="apps"]');
  await waitFor(`!!document.querySelector("#lp .lp-app")`, 20000);
  await sleep(2200);
  await t.say("搜一下：打字就筛");
  await t.clickSel("#lp-q");
  await t.type("计算", 120);
  await sleep(1200);
  await t.say("桌面应用：它自己的窗口贴到台面的一块上");
  await t.clickSel('#lp [data-lpapp]');
  await waitFor(`Z.some((z) => z.kind === "app" && z.appz.st === "glued")`, 20000);
  await sleep(2400);
  await t.say("跟着块走、跟着块缩放（它自己有最小尺寸，块就长到装得下它）");
  const zh = await t.ev(`(() => { const z = Z.find((x) => x.kind === "app"); const r = ZEL.get(z.id).querySelector(".zh").getBoundingClientRect(); return [Math.round(r.left + 200), Math.round(r.top + r.height / 2)]; })()`);
  await t.drag(zh[0], zh[1], zh[0] + 1080, zh[1] + 100, 1500);
  await sleep(1200);
  const se = await t.ev(`(() => { const z = Z.find((x) => x.kind === "app"); const r = ZEL.get(z.id).querySelector('[data-rz="se"]').getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
  await t.drag(se[0], se[1], se[0] + 110, se[1] + 60, 1100);
  await sleep(1800);
  await t.say("打开设置、启动台这些浮层时，贴着的窗口先让开");
  await t.clickSel('[data-dock="set"]');
  await sleep(2000);
  await t.clickSel("[data-sx]");
  await sleep(1600);

  await t.say("网页：输入网址或关键词回车 —— 开在 Perch 自己的浏览器内核里，登录状态会记住");
  await t.clickSel('[data-dock="apps"]');
  await sleep(900);
  await t.clickSel("#lp-q");
  await t.type("example.com", 90);
  await sleep(900);
  await t.clickSel('#lp [data-lpurl]');
  await waitFor(`Z.some((z) => z.kind === "web" && z.web.ready)`, 20000);
  await sleep(2400);
  await t.say("块上面是它的地址栏：换个地址、后退、刷新、在外部浏览器打开");
  const url = await t.at('[data-wurl]');
  await t.click(url[0], url[1]);
  await t.ev(`(() => { const i = document.querySelector("[data-wurl]"); i.select(); return 1; })()`);
  await t.type("https://www.iana.org/help/example-domains", 25);
  await t.ev(`(() => { const i = document.querySelector("[data-wurl]"); i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return 1; })()`);
  await sleep(3500);
  await t.clickSel("[data-wback]");
  await sleep(2600);

  await t.say("收起 Perch：网页先藏起来、贴着的应用缩到任务栏；回到台面按原样摆回去");
  await t.stowed(async (o) => { await o.sleep(1800); await o.hover(); await o.sleep(1400); await o.leave(); await o.click(); });
  await sleep(2600);

  await t.say("关掉应用那一块 = 请它自己关（有没保存的，它自己会问）；想留着它就点「弹出成普通窗口」");
  const zx = await t.ev(`(() => { const z = Z.find((x) => x.kind === "app"); const r = ZEL.get(z.id).querySelector('[data-zact="close"]').getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
  await t.click(zx[0], zx[1]);
  await sleep(1400);
  await t.clickSel('#cf [data-cf="ok"]');
  await sleep(1800);
  await t.say("");
}
