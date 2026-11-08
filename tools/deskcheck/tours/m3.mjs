// M3 导览：模型（提供商、默认模型、格子随时换）/ Bot Group（建组、群聊、拍板、交接、成员详情、人设、加 Bot、暂停）。
// 前提（测试实例）：两个假提供商 mock18901 / mock18902（tools/deskcheck/mockprov.mjs，一分钱不花）；Claude 默认走 mock18901；
// 项目 bgproj（D:\AIAgents\_tools\termtest-run\bgproj，git 仓库）。开录前把台面上的块都收起来、关掉 Bot Group 块。
export default async function (t) {
  const { sleep } = t;
  const send = async (sel, text) => { await t.clickSel(sel); await t.type(text, 55); await sleep(300); };
  const waitFor = async (js, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await t.ev(js)) return true; await sleep(400); } return false; };

  await t.say("M3 · 模型：设置 › 模型 —— 加提供商（官方、中转站、本地），填 key、检测、保存");
  await t.clickSel('[data-dock="set"]');
  await sleep(1200);
  await t.clickSel('[data-snav="models"]');
  await sleep(2600);
  await t.say("设置 › Agents：每个 agent 新开格子时默认用哪个模型、推理强度");
  await t.clickSel('[data-snav="agents"]');
  await sleep(2600);
  await t.clickSel("[data-sx]");
  await sleep(600);

  await t.say("格子头上的模型按钮：随时换，不用重启 —— 干活中的这一轮跑完再换");
  await t.ev(`(() => { const z = Z.find((x) => x.kind === "agents"); expandZone(z); return 1; })()`);
  await sleep(1400);
  const tm = await t.ev(`(() => { const e = [...document.querySelectorAll("[data-tmodel]")].find((x) => x.getBoundingClientRect().width > 0); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`);
  if (tm) {
    await t.click(tm[0], tm[1]);
    await sleep(1400);
    await t.clickSel('#mp [data-mprov="mock18902"][data-mpick="mockb-small"]');
    await sleep(2400);
  }
  await t.ev(`(() => { collapseAll(); return 1; })()`);
  await sleep(1000);

  await t.say("Bot Group：Dock 上这一颗，然后在台面上圈一块");
  await t.clickSel('[data-dock="group"]');
  await sleep(800);
  await t.drag(300, 100, 1500, 880, 1200);
  await sleep(1200);
  await t.say("第一步：名字、目标、在哪个项目里干、预算上限");
  await send("[data-gf=name]", "官网改版小队");
  await send("[data-gf=goal]", "在 README 里加一段 Perch 的介绍");
  await t.clickSel('[data-gproj$="bgproj"]');
  await sleep(600);
  await t.clickSel('[data-gbud="1000"]');
  await sleep(700);
  await t.clickSel("[data-gnext]");
  await sleep(1200);
  await t.say("第二步：Manager 拆活派活；一个角色配一个 agent");
  await t.clickSel('[data-gbpre="审阅"]');
  await sleep(900);
  await t.say("每个成员都有「人设与岗位」：职责、风格、能动哪些地方、什么时候找你拍板");
  await t.clickSel('[data-gbedit="0"]');
  await sleep(1800);
  await t.clickSel('[data-pfx="forbid.deps"]');
  await sleep(900);
  await t.clickSel('[data-gbedit="0"]');
  await sleep(700);
  await t.clickSel("[data-gnext]");
  await sleep(1200);
  await t.say("第三步：核对一遍就开工 —— 每个 Bot 在项目里有自己的工作副本（git worktree），互不踩脚");
  await sleep(2600);
  await t.clickSel("[data-gstart]");
  await t.say("开工：目标先交给 Manager，它的回答回到群里（这里接的是假提供商，回答是固定的一句）");
  await waitFor(`[...document.querySelectorAll(".g-feed .gmsg")].some((e) => e.textContent.includes("Manager") && e.textContent.includes("Mock"))`, 30000);
  await sleep(1800);

  await t.say("在群里说话：不点名 = 交给 Manager；@角色 = 交给它；@全员 = 所有人");
  await send("[data-gin]", "@审阅 ASKTEST 先问我一个问题");
  await t.clickSel("[data-gsend]");
  await t.say("成员停下来问你：拍板卡就在群里，直接点");
  await waitFor(`!!document.querySelector(".g-feed .gmsg.asking [data-gpick]")`, 30000);
  await sleep(2200);
  await t.clickSel('.g-feed .gmsg.asking [data-gpick="2"]');
  await sleep(3000);

  await t.say("Bot 之间的交接由 Perch 转达：Manager 用 perch-bg 派活，对方空闲时送到，做完自动交回");
  await send("[data-gin]", "HANDOFFTEST 审阅 把这件派下去");
  await t.clickSel("[data-gsend]");
  await waitFor(`[...document.querySelectorAll(".g-feed .gtag")].some((e) => e.textContent.includes("交回"))`, 45000);
  await sleep(3500);

  await t.say("点一个成员 = 成员详情：它在干什么、职责、换模型、单聊（只有它看得到）");
  await t.clickSel('[data-gmem="b1"]');
  await sleep(2000);
  await t.clickSel(".gd-h [data-gmodel]");
  await sleep(1200);
  await t.clickSel('#mp [data-mprov="mock18902"][data-mpick="mockb-large"]');
  await sleep(1800);
  await send("[data-gdin]", "单聊一句：换了模型以后你是谁？");
  await t.clickSel("[data-gpsend]");
  await waitFor(`[...document.querySelectorAll(".gd-lines .ln.say")].some((e) => e.textContent.includes("MockB"))`, 30000);
  await sleep(2200);
  await t.say("要看它的终端（登录、批权限）也在这里");
  await t.clickSel('[data-gterm="b1"]');
  await sleep(2800);
  await t.clickSel('[data-gterm="b1"]');
  await sleep(700);
  await t.say("人设与岗位开工后也能改：保存后下一轮起按新的来，不用重启；还能存成模板");
  await t.clickSel("[data-gpedit]");
  await sleep(1600);
  await t.ev(`(() => { const x = document.querySelector('.gd-pf [data-pf="duty"]'); x.focus(); x.setSelectionRange(x.value.length, x.value.length); return 1; })()`);
  await t.type(" 改 README 前先给审阅看。", 60);
  await sleep(500);
  await t.clickSel("[data-gpetpl]");
  await sleep(1400);
  await t.clickSel("[data-gpesave]");
  await sleep(1800);
  await t.clickSel("[data-gdclose]");
  await sleep(600);

  await t.say("中途加 Bot：从托盘把 agent 拖进群里，起个角色名就加进来了");
  await t.clickSel('[data-dock="agent"]');
  await sleep(1000);
  const cx = await t.at('[data-tray="codex"]');
  await t.drag(cx[0], cx[1], 900, 520, 1100);
  await sleep(900);
  await t.clickSel('[data-gaddpre="测试"]');
  await sleep(700);
  await t.clickSel("[data-gaddok]");
  await waitFor(`[...document.querySelectorAll(".g-feed .gmsg.sys")].some((e) => e.textContent.includes("加入了群"))`, 20000);
  await sleep(2200);

  await t.say("预算条：组里花掉的 / 上限，花到了先停下问你；「全部暂停」：手上这一步做完就停");
  await t.clickSel("[data-gpause]");
  await sleep(2200);
  await t.clickSel("[data-gpause]");
  await sleep(1600);

  await t.say("总览里也能看到每个 Bot Group：成员、项目、预算，点一下跳过去");
  await t.clickSel('[data-dock="ov"]');
  await sleep(2600);
  await t.clickSel("#ov .ov-g");
  await sleep(1600);
  await t.say("");
}
