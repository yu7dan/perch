// M1 导览：台面外壳 + Dock + 收起成悬浮按钮（真产品，测试实例）。
// 用法：node tools/deskcheck/tour.mjs tools/deskcheck/tours/m1.mjs <输出.mp4>
export default async function (t) {
  const { sleep } = t;
  await t.say("M1 · 台面：Perch 铺满整个屏幕，背景就是你的桌面壁纸");
  await sleep(2600);

  await t.say("在空白处按住拖一下 = 圈出一块地方");
  await t.drag(260, 150, 1180, 720, 1200);
  await sleep(900);
  await t.say("选这块拿来干什么：并行 Agents / 单个 Agent / Bot Group / 文件");
  await sleep(1800);
  await t.clickSel('[data-choose="par"]');
  await sleep(900);

  await t.say("每一格放一个 agent —— 选项目、选 agent，格子里就是它真的终端");
  await t.clickSel('[data-proj]', 1);
  await sleep(500);
  await t.clickSel('[data-pick="claude"]');
  await sleep(4500);
  await t.say("键盘直接打进去（这里只打字、不发送）");
  await t.type("给首页换一张台面截图");
  await sleep(1200);

  await t.say("格子边上的 + = 往那边切出一格；切分始终铺满这一块");
  const tile = await t.at(".tile", 0);
  await t.move(tile[0], tile[1]);
  await sleep(500);
  await t.clickSel('.tile [data-plus="bottom"]');
  await sleep(900);
  await t.say("Dock 的 ✦ 是 Agent 托盘：拖到空格子里 = 放进去");
  await t.clickSel('[data-dock="agent"]');
  await sleep(700);
  const src = await t.at('[data-tray="claude"]');
  // 托盘会盖住格子下半截：往空格子的上半部放
  const empty = await t.ev(`(() => { const r = document.querySelector(".tile.empty").getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + 50)]; })()`);
  await t.drag(src[0], src[1], empty[0], empty[1], 1100);
  await sleep(4000);

  await t.say("拖格子之间的缝调大小");
  const dv = await t.at(".dv.v");
  if (dv) await t.drag(dv[0], dv[1], dv[0], dv[1] - 90, 700);
  await sleep(800);
  await t.say("双击格头 = 这一格占满整块；再点一下右上角就回来");
  const th = await t.at(".tile .th b", 0);
  await t.dbl(th[0] + 40, th[1]);
  await sleep(1500);
  await t.clickSel("[data-unfocus]");
  await sleep(900);

  await t.say("按住块头拖着走；拖角落改大小。块和块默认不重叠");
  const zh = await t.at(".zone .zh .zt");
  await t.drag(zh[0] + 120, zh[1], zh[0] + 220, zh[1] + 60, 900);
  await sleep(500);
  const se = await t.at('.zone [data-rz="se"]');
  await t.drag(se[0], se[1], se[0] + 160, se[1] + 90, 900);
  await sleep(900);

  await t.say("再圈一块，放一个单独的 agent");
  await t.drag(1480, 150, 1880, 760, 1000);
  await sleep(600);
  await t.clickSel('[data-choose="one"]');
  await sleep(600);
  await t.clickSel('.zone:last-child [data-pick="claude"]');
  await sleep(4000);

  await t.say("每一块都能收起成标签：可以拖、点一下回到原位");
  await t.clickSel(".zone:last-child [data-zcollapse]");
  await sleep(1000);
  const tab = await t.at(".ztab b");
  await t.drag(tab[0], tab[1], tab[0] - 200, tab[1] + 300, 900);
  await sleep(700);
  await t.click(tab[0] - 200, tab[1] + 300);
  await sleep(1200);
  await t.say("Dock 上「全部收起」：所有块沿着 Dock 排成一排；再点一下全部展开");
  await t.clickSel('[data-dock="fold"]');
  await sleep(1800);
  await t.clickSel('[data-dock="fold"]');
  await sleep(1500);

  await t.say("Dock 可以拖到任何地方：贴左右边就竖过来，台面自动让出那一条");
  const grip = await t.at("#dock .dgrip");
  await t.drag(grip[0], grip[1], 30, 540, 1300);
  await sleep(1600);
  const grip2 = await t.at("#dock .dgrip");
  await t.drag(grip2[0], grip2[1], 960, 1060, 1300);
  await sleep(1400);

  // 测试实例的窗口在屏幕外：把按钮放进录像画面里（真用时默认贴在主屏右边）
  await t.ev("CFG.orb = { x: screenX + 1440, y: screenY + 600 }");
  await t.say("收起 Perch：整个台面缩成桌面上一个悬浮按钮，agent 照样在跑");
  await sleep(1200);
  await t.stowed(async (o) => {
    await o.sleep(1800);
    await o.hover();
    await o.sleep(2200);
    await o.leave();
    await o.sleep(700);
    await o.click();
    await o.sleep(800);
  });
  await t.say("点一下悬浮按钮就回到台面，一切原样");
  await sleep(2200);

  await t.say("关掉一格：记录留着，之后能接回；关掉一块会先问一句");
  await t.clickSel(".zone:last-child [data-zact=close]");
  await sleep(1400);
  await t.clickSel('#cf [data-cf="ok"]');
  await sleep(1500);
  await t.say("M1 完成：台面外壳、切格、收起成标签、Dock、悬浮按钮。下一步：项目 / 文件 / 设置 / 总览");
  await sleep(3000);
}
