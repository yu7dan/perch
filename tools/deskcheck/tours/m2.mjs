// M2 导览：项目 / 选文件夹 / 文件块 / 设置 / 总览（真产品，测试实例）。
// 前提：测试实例里有项目 termtest（D:\AIAgents\_tools\termtest-run\proj，里面有 README.md / src / docs）。
export default async function (t) {
  const { sleep } = t;
  // 选文件夹窗口里按名字找一行（先滚进视野再量位置）
  const row = (name) => t.ev(`(() => { const r = [...document.querySelectorAll("#fpk [data-fpsel]")].find((e) => e.querySelector("b").textContent === ${JSON.stringify(name)}); if (!r) return null; r.scrollIntoView({ block: "center" }); const b = r.getBoundingClientRect(); return [Math.round(b.x + 80), Math.round(b.y + b.height / 2)]; })()`);
  const openRow = async (name) => { const p = await row(name); if (!p) throw new Error("no row " + name); await t.dbl(p[0], p[1]); await sleep(700); };

  await t.say("M2 · 项目与文件：项目就是盘上的一个文件夹");
  await sleep(1800);
  await t.clickSel('[data-dock="proj"]');
  await sleep(1600);
  await t.say("添加文件夹：可以选盘上任意位置已有的，也可以自己定建在哪、新建一个");
  await t.clickSel('[data-pp="add"]');
  await sleep(1200);
  await t.clickSel('[data-pp="create"]');
  await sleep(1200);
  await t.say("这是真磁盘：点一下选中，双击进去");
  await t.clickSel('[data-fpplace=""]');
  await sleep(900);
  await openRow("D: 盘");
  await openRow("AIAgents");
  await openRow("_tools");
  await openRow("termtest-run");
  await t.say("进到哪个文件夹，新文件夹就建在哪");
  await t.clickSel("#fpk-name");
  await t.type("官网改版");
  await sleep(500);
  await t.clickSel("#fpk [data-fpok]");
  await sleep(1800);
  await t.say("加好了：项目面板里多了一行。在这一行上可以直接开 Agent、看文件");
  await t.clickSel('[data-dock="proj"]');
  await sleep(2200);
  await t.say("「看文件」= 在台面上开一个「文件」块");
  await t.ev(`(() => { const r = [...document.querySelectorAll("#pp .pr")].find((e) => e.textContent.includes("termtest")); r.querySelector('[data-pp="files"]').style.opacity = 1; })()`);
  const fb = await t.ev(`(() => { const r = [...document.querySelectorAll("#pp .pr")].find((e) => e.textContent.includes("termtest")); const b = r.querySelector('[data-pp="files"]').getBoundingClientRect(); return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)]; })()`);
  await t.click(fb[0], fb[1]);
  await sleep(1500);
  await t.say("「碰过的」：agent 在这个项目里读过、改过、新建的文件 —— 谁动的都列出来");
  await sleep(2600);
  await t.clickSel('.fz [data-ftab="all"]');
  await sleep(900);
  await t.say("「全部」：项目文件夹里有什么；点开一个文件看内容");
  const src = await t.ev(`(() => { const b = [...document.querySelectorAll(".fz [data-fdir]")].find((e) => e.textContent.includes("src")); if (!b) return null; const r = b.getBoundingClientRect(); return [Math.round(r.x + 60), Math.round(r.y + r.height / 2)]; })()`);
  if (src) { await t.click(src[0], src[1]); await sleep(700); }
  const mg = await t.ev(`(() => { const b = [...document.querySelectorAll(".fz [data-fopen]")].find((e) => e.textContent.includes("main.go")); if (!b) return null; const r = b.getBoundingClientRect(); return [Math.round(r.x + 60), Math.round(r.y + r.height / 2)]; })()`);
  if (mg) { await t.click(mg[0], mg[1]); await sleep(2200); }

  await t.say("格子头上的 📄 数字 = 这个 agent 碰过几个文件；点开清单，点一个就在「文件」块里打开");
  const tf = await t.at("[data-tfiles]");
  if (tf) {
    await t.click(tf[0], tf[1]);
    await sleep(1600);
    await t.clickSel(".peek [data-peekf]");
    await sleep(2000);
  }

  await t.say("设置：通用 / 台面 / 项目 / 模型 / Agents / 关于");
  await t.clickSel('[data-dock="set"]');
  await sleep(2200);
  await t.say("台面：背景、玻璃、强调色、Dock 位置 —— 改了马上生效");
  await t.clickSel('[data-snav="desk"]');
  await sleep(1200);
  await t.clickSel('[data-cfgseg="bg"][data-v="grad"]');
  await sleep(1400);
  await t.clickSel('[data-cfgseg="bg"][data-v="wall"]');
  await sleep(900);
  await t.clickSel('[data-acc="#7dd3c0"]');
  await sleep(1300);
  await t.clickSel('[data-acc="#8aa4ff"]');
  await sleep(700);
  await t.say("项目：默认工作区和项目列表，和 Dock 里那份是同一份");
  await t.clickSel('[data-snav="proj"]');
  await sleep(2200);
  await t.say("刚建的那个项目在这里移除（盘上的文件夹不动）");
  const rm = await t.ev(`(() => { const r = [...document.querySelectorAll("#set .pr")].find((e) => e.textContent.includes("官网改版")); if (!r) return null; const b = r.querySelector('[data-pp="rm"]'); b.style.opacity = 1; const q = b.getBoundingClientRect(); return [Math.round(q.x + q.width / 2), Math.round(q.y + q.height / 2)]; })()`);
  if (rm) { await t.click(rm[0], rm[1]); await sleep(1600); }
  await t.clickSel("[data-sx]");
  await sleep(800);

  await t.say("总览：在跑的、在等你的、每天的轮次和 token、按模型的用量 —— 都是本机的真实数据");
  await t.clickSel('[data-dock="ov"]');
  await sleep(2600);
  await t.clickSel('[data-ovm="tok"]');
  await sleep(2400);
  await t.clickSel("[data-ovgo]");
  await sleep(1600);
  await t.say("M2 完成：项目、选文件夹、文件块、设置、总览。下一步：模型 / Bot Group / 人设 / 就地下载");
  await sleep(3000);
}
