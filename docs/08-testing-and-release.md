# 测试、门禁与发版

> 这个仓库靠哪几层门禁保命、性能数字怎么量、怎么发版，以及发版那条「别急着重发」的纪律。

## 目录

1. [三层测试](#1-三层测试)
2. [jsdom 里的 canvas 桩](#2-jsdom-里的-canvas-桩)
3. [浏览器审计](#3-浏览器审计)
4. [性能尺子](#4-性能尺子)
5. [示例页与截图](#5-示例页与截图)
6. [CI 与本地门禁](#6-ci-与本地门禁)
7. [发版流程](#7-发版流程)
8. [提交与文档纪律](#8-提交与文档纪律)

## 1. 三层测试

| 层 | 目录 | 盯什么 |
|---|---|---|
| **纯函数** | `tests/{option,layout,scale,util,expr,theme}/` | 归一化、布局、比例尺、表达式、颜色预算。无 DOM、无 canvas，跑得最快 |
| **组件** | `tests/components/` | 命中判定、像素缓存新鲜度、抽样规则、虚拟系列的各形态 |
| **引擎集成** | `tests/{chart,interaction,a11y}/` | 真实渲染 → 真实命中 → 真实事件派发：多图隔离、联动、序列化、数据流、动画 |

两条硬规矩：

1. **不要 mock 引擎**。集成测试走真实链路，才能抓到「渲染与命中不一致」「多图串扰」
   这类只在真实链路上暴露的问题；把引擎换掉等于把这些用例变成自说自话。
2. **新增能力补三类用例**（纯函数 / 组件命中 / 端到端交互），并在 `plans/*.md` 或
   `CHANGELOG.md` 里写下实测数字与口径。

## 2. jsdom 里的 canvas 桩

`tests/setup/canvas-env.ts` 提供 Canvas 2D 上下文桩：**只记录状态、不真正光栅化**
（像素级回归交给浏览器审计）。

- jsdom 需要补 `crypto.randomUUID`（引擎用它生成组件 id），已放在 setup 里。
- 交互测试直接调 `controller.handlePointerMove / Down / Up / Click / Wheel / KeyDown`
  （入参是画布 CSS 像素），不需要合成 DOM 事件。
- 需要真实浏览器行为时用 `examples/` + Playwright。
- 动效偏好全局设为 `instant`：断言确定、跑得快；动画时序另有 `tests/chart/animation.test.ts` 覆盖。

## 3. 浏览器审计

两把尺子，都在真机 Chromium 上跑示例页：

| 脚本 | 覆盖 | 断言什么 |
|---|---|---|
| `npm run audit:interactions -- ./.audit` | 30 个示例页、**322 步**（最近几次实测都是这个数） | 逐步走真实交互，断言几何关系：提示框不越界、不压坐标轴标签 / 图例；高亮在绘图区内；没有饱和色墨迹跑到坐标轴带上 |
| `npm run audit:hover -- ./.hover-sweep` | **18 种类型、399 项检查** | 逐类型逐数据点真实悬停：反馈动画到位、几何不越界、**像素缓存新鲜**、无 console 报错，并按「图 × 系列」截图供人工复核 |

两条经验：

1. **审计不是稳定门禁**：曾在基线（未含本次改动）上连跑 3 次、3 次全红（都在「布局几何变了」那一步）。
   所以**不要用单次运行的结果当「全绿」的证据**；判定失败时先看它是不是已知的偶发项。
2. **探针的视口宽度必须 ≥ 内容设计宽**：大屏设计宽 1572 时用 1280 的视口，最右侧面板在视口外、
   鼠标移过去不产生事件，探针会偶发报「hoverIndex: null」——看起来像图表坏了，其实是探针够不着。

## 4. 性能尺子

| 脚本 | 量什么 |
|---|---|
| `node scripts/measure-pipeline.mjs --points 100000` | **更新流水线**：逐 tick 追加，给「每 tick p50」与「其中 `applyOption`」。三档：普通（`setData` 重建）、惰性原始点 + 环形、环形 + 视窗 |
| 浏览器 CDP `Performance.getMetrics` | 把渲染进程任务时间拆成 **脚本 / 样式 / 布局 / 其余（光栅 + 合成 + GC）** —— 判断「帧为什么慢」用它，别用 CPU profile 的 `(program)`（那只是「没有 JS 在栈上」的统称） |
| `node scripts/audit-space.mjs` | 排版留白（圆形图放进宽卡片的死区大小） |

读数纪律（详见 `02-pipeline.md` §8）：**帧 ≠ 流水线**；同一份数据同一张画布，
虚拟（列存）折线 16.7ms/帧而普通折线 61ms/帧；三种取点策略已实测，LTTB 最快，别再试。

## 5. 示例页与截图

1. `npm run examples:serve` → `http://localhost:5177/examples/`。
   示例页吃的是 `examples/vendor/`（由 `examples:prepare` 从 `dist` 同步）—— **改完要先 `npm run build`**。
2. 新增示例页时把它加进 `scripts/audit-interactions.mjs` 与 `scripts/hover-sweep.mjs` 的 `pages` 列表，
   否则门禁覆盖不到。
3. README 的截图由 `scripts/readme-shots.mjs` 生成（产物在 `docs/screenshots/`）：
   改了主题 / 大屏配色 / 示例布局之后要重跑，别让文档里的图停在旧版本。

## 6. CI 与本地门禁

```bash
npm run verify        # lint → types:check → build → jest（提交前必跑）
npm run verify:full   # verify + test:e2e（示例页冒烟，发版前跑）
```

CI（`.github/workflows/ci.yml`）在 push / PR 上跑 `npm run verify`（Node 20，引擎走 npm 依赖）。
示例页冒烟用 Playwright，本地跑之前记得 `npm run build && npm run examples:prepare`。

## 7. 发版流程

**分支纪律**：开发在临时分支或 `dev` 上做；`main` 只做集成与发版。
**发版前必须先把开发分支合并进 `main`，再从 `main` 发版。**
远端默认分支指向 `main`，且 Gitee 与 GitHub **两处都要推**。

步骤：

1. `main` 上改 `package.json` / `package-lock.json` 的版本号，并把 `CHANGELOG.md` 的
   `[Unreleased]` 段落转成 `## [x.y.z] - 日期`（保留一个空的 `[Unreleased]` 占位）。
2. 跑门禁：`npm run verify` + `npm run test:e2e`。
3. 提交 `chore(release): x.y.z（一句话）`，打**带说明的 tag** `vX.Y.Z`（文案风格：`ice-chart x.y.z：…`）。
4. 双推 `main` 与 tag：`git push origin main --follow-tags` / `git push github-origin main --follow-tags`。
5. `npm publish`（`prepublishOnly` 会自动再跑一遍 `npm run verify`）。
6. **核验以 packument 为准，不以 `npm publish` 的回显或 `npm view` 为准**：

```bash
curl -s "https://registry.npmjs.org/@damoqiongqiu%2Fice-chart" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);console.log(d["dist-tags"], Object.keys(d.versions).slice(-3))})'
curl -s -o /dev/null -w "%{http_code}\n" https://registry.npmjs.org/@damoqiongqiu/ice-chart/-/ice-chart-X.Y.Z.tgz
```

⚠️ **`npm publish` 报成功 ≠ 包已经可用**（实测两次）：发布后有一段**异步落地窗口**，
期间 packument 还是旧版本、tarball 直连 404。0.30.11 约 4 分钟、0.30.12 约 6 分钟才可见。
**别急着重发** —— 重复发布是在赌一个「版本已存在」的报错；正确做法是等，并以
「packument 上看得见新版本 **且** `dist-tags.latest` 指过去」作为「发版完成」的判据。

## 8. 提交与文档纪律

1. **提交信息里不许出现第三方 / 竞品项目名**：调研得来的做法要**内化成我们自己的规范**再写进来
   （写「近黑蓝底 + 单一强调色 + 卡片式面板」，而不是写「参考了某某大屏」）。
2. 提交信息用 `type(scope): 中文摘要（数字 → 数字）`，正文写清**为什么**、**实测口径**与**门禁结果**。
3. 改代码时同步更新：本目录的文档、根 `AGENTS.md` 的纪律条目、`CHANGELOG.md` 的用户可读变更；
   「还剩什么」与施工图放 `plans/`。
