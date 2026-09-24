# AGENTS.md — ice-chart

## 仓库纪律：不要写第三方 / 竞品项目名

**仓库里的任何地方都不许出现第三方或竞品项目的名字** —— 包括源码注释、文档、示例页、
测试、脚本、CHANGELOG，以及 **git 提交信息**。

- 例外只有两类：① 有**明确开源协议**的项目（
  但要引用到具体行为/约定时才写，别当"设计参考"来源写）；② 大品牌（作为生态事实提及）。
- 调研得来的东西请**内化成我们自己的设计规范**再写进仓库：
  写「近黑蓝底 + 单一强调色 + 卡片化面板 + 四角亮角 + 整宽 KPI 分隔条」，
  而不是写「参考了某某大屏」。**描述结果，不描述来源。**
- 提交信息同样受约束：不要出现"参考 / 对标 / 看齐 + 具体项目名"这类表述。
- 需要致谢时写在独立致谢段并附协议，不要散落在代码注释里。

## 项目定位

ice-chart 是构建在 **ice-render** Canvas 引擎之上的交互式图表库（MIT）。
引擎负责渲染 / 命中测试 / 事件派发 / 坐标系 / 脏矩形局部重绘，chart 层只做三件事：
**数据 ↔ 像素 ↔ 语义事件**。

读者请先读 `../ice-render/AGENTS.md`（引擎铁律），本文件只记录 chart 层的约定与踩过的坑。

## 架构分层（修改前必读）

- `option/normalize.ts`：纯函数。把用户 option 归一化成数据点 / 数据域 / 堆叠基线。
  不依赖 DOM / ctx / 引擎，必须可单测。
- `layout/layout.ts`：纯函数。用临时比例尺量刻度 → 排标题与图例 → 推出绘图区矩形。
- `scale/`：linear / category / time / log。`fractionOf / valueAtFraction` 是跨图联动的对齐基础。
- `components/`：渲染层。`SeriesBase` 的 `containsLocalPoint` **就是数据命中判定**，
  由引擎的 `ice.hitTest()` 直接调用。
- `interaction/`：`HitResolver`（像素 → 组件 → 数据下标）+ `InteractionController`
  （悬停 / 选中 / 框选 / 缩放 / 平移 / 键盘）+ `ChartLink`（跨图联动）。
- `ICEChart.ts`：编译管线（归一化 → 布局 → 比例尺 → 组件同步）与生命周期。

### 铁律

1. **命中判定必须写在组件的 `containsLocalPoint` 里**，不要在图表层另写一套「坐标反查数据」。
   遮挡关系、zIndex、`display:false`、`interactive:false` 全部由引擎统一保证；重写一套必然与渲染漂移。
2. **像素缓存唯一**：`rebuildPixels()` 是点集像素的唯一来源，渲染与命中都消费它。
   任何「渲染时另算一遍坐标」的写法都会让「看得见的点」与「点得到的点」分叉。
   **例外只有虚拟（列存）系列**（`virtual: true` 的 scatter，2026-09-21）：它不物化像素缓存
   （100 万点的 `pixels` + `effective` + `itemProgress` 就是 40MB，省下的内存会被缓存吃回去），
   渲染与命中都从**列 + 同一份比例尺**现算 —— 同一处公式、同一份数据，不存在两套坐标；
   换来的代价见「虚拟（列存）系列」一节。除它之外，一律照旧走像素缓存。
3. **组件的 `doRender()` 必须自己 `ctx.beginPath()`**。引擎的脏矩形局部重绘会在 ctx 上留下
   `clip` 用的 rect 路径，直接 `ctx.stroke()` 会把那条残留路径一起描出来 ——
   表现为画布边缘莫名多出一圈与最后绘制的系列同色的线。`ICEPath` 系组件因为有独立 Path2D 才不需要担心。
4. **禁止直接调用 `ICEEvent.preventDefault()`**：引擎的 `ICEEvent` 只是接口模拟（调用会抛异常），
   某些路径下事件对象上的 `preventDefault` 还是未绑定的原生方法（抛 `Illegal invocation`）。
   统一走 `InteractionController.preventDefault()`（取 `originalEvent` + try/catch）。
5. **引擎的原生事件监听挂在 window 上**：同一页面上的每张图都会收到**全页面**的事件。
  一切指针入口都必须先过 `isOverCanvas()`，否则会出现「在 A 图移动鼠标，B 图清掉刚镜像的悬停」。
   **注意**：坐标换算用的是引擎缓存的 canvas 内容盒，页面在画布上方插入内容 / 滚动会让它过期 ——
   引擎 1.4.5 起移动事件每帧重读（`ICE.refreshInputRect()`），当前 peer 依赖是 `^1.4.7`；
   在那之前**不要把会产生布局变化的面板放在画布上方**（示例页踩过：状态行出现后画布下推 26px，
   悬停直接落空，8 个悬停探针失败）。
6. **键盘只由最后激活的图响应**（模块级 `activeController`，`destroy()` 时释放）。
   不要在 `keydown` 里对所有图生效。
7. **联动回显必须 `silent()`**：`linkCharts` 把事件转发给其它图时必须包在 `chart.silent()` 里，
   否则 A→B→A 会无限递归（已踩过：RangeError: Maximum call stack size exceeded）。
8. **交互反馈用独立覆盖层，不要重绘系列**：鼠标移动只让 `Highlight / Crosshair / Tooltip` 变脏；
   压暗其他系列只在「悬停系列变化」时写一次 state。每次 mousemove 写系列 state 会让脏矩形失效。
9. **组件 props/state 只放可序列化的配置**；比例尺、像素缓存、命中索引等运行时状态放普通字段，
   不要进 state/props（序列化与内存都受影响）。
10. **纯函数层不许引入引擎依赖**：`normalizeOption` / `computeLayout` / `scale` 必须能在没有 DOM、
    没有 canvas 的环境下运行与测试。
11. **用户输入的表达式一律走 `src/expr`**：禁止 `eval` / `new Function`（CSP 与安全），
    编译失败要能给出位置，且**不能让图表崩**（错误经 `chart.expressionErrors()` 暴露）。

## 成员顺序（2026-09-17 定）

家族的应用层（各仓的页面 / 示例页）按这个顺序排类成员，正则 `S*T*F*C*(A|M)*`：

```
static 常量/字段  →  static 方法  →  实例字段  →  构造函数  →  访问器 / 实例方法
```

**本仓是库，`src/` 不强制这条** —— 2026-09-17 体检里只有 3 个类偏离（`ICEChart` 的
`static restore()` 放在类尾、`Annotation` / `TreemapSeries` 的私有 scratch 字段紧挨着
用到它的方法），都是能讲得通的"就近放置"。为排版搬家不值得：**TS 里字段的声明顺序是有语义的**
（初始化按声明顺序执行 + 影响 V8 的 class shape），何况 Google Java Style §3.4.2 明确说
成员顺序"**没有唯一正确的配方**"、Google 的 TypeScript 指南对顺序**完全沉默**
（全文 "ordering" 出现 0 次）。

**新代码照契约写；老代码遇到再改**（Boy Scout）。示例页（`examples/*.html`）按契约排。

## 坐标与原点约定

- 所有图表组件 `origin: 'top-left'`，本地坐标系就是「左上角为原点」的像素坐标；
  引擎默认的 `localCenter` 会让 `containsLocalPoint` 的默认实现（±width/2）与图表直觉不符。
- **系列组件**的盒 = 绘图区矩形，本地坐标 = 绘图区内的像素（0..plotWidth / 0..plotHeight）。
- **其它组件**（坐标轴 / 图例 / 标题 / 覆盖层）的盒 = 整块画布，绘制时直接用图表坐标系，
  这样轴标签、提示框可以自然画到绘图区之外，不必扩展包围盒。
- `chart.layout.*` 与 `series.pixelAt()` 返回的都是**图表坐标系（画布左上角为原点）**，
  对外事件里的 `screen` 才经过 `ice.worldToScreen()`。

- **引擎图元的 `left/top` 就是绘制盒的左上角**，`origin` 只影响**变换枢轴**（旋转/缩放的锚点），
  引擎内部用 `localOrigin` 在矩阵里补掉了偏移。给图元摆位时**不要**再按 `origin` 做中心换算 ——
  实测那样会把整块带状图元推出绘图区（画到画布外，审计报 91 像素越界）。
- **引擎图元的 `style` 键名是 ctx 属性名**（`fillStyle` / `strokeStyle` / `lineWidth`），
  `fill` / `stroke` 是「要不要填充 / 描边」的布尔。写成 `style: { fill: '#f00' }` 会把 ctx 上的
  `fill()` 方法覆盖成字符串，运行时抛 `this.ctx.fill is not a function`（踩过）。
- **交互要给图元让路**：`InteractionController` 的按下处理必须在命中图元时提前返回，
  否则「拖注释」会变成「拖画布」（框选 / 平移抢走拖拽）。
- **纵向平移的符号和横向是反的**（2026-09-21 修，别改回去）：
  `shiftDomain` 要让内容**跟着手走**。x 轴「值越大越靠右」与屏幕同向，用 `-deltaPixels`；
  y 轴「值越大越靠上」与屏幕**反向**，必须用 `+deltaPixels` —— 同一个符号会让纵向拖动
  方向整个反过来（用户一眼就看出来了）。类目轴不走这条：band 的像素方向对两个轴
  都是「下标越大越靠下/右」，所以那边不用翻。
- **平移不许和数据范围求交**（2026-09-21 修，别改回去）：`clampAxisDomain` 会
  `d0 = max(f0, ...)` / `d1 = min(f1, ...)`，那是给缩放用的。平移这么做会把窗口
  一端夹住、另一端继续走 —— **平移被悄悄退化成缩放**（实测 K 线页纵向拖 120px，
  量程从 `[41100,41700]` 变成 `[41100,41449]`，顶端不动、底端上移）。
  现在 `source === 'pan'` 单独走一条：保住跨度，只要求与数据范围至少交叠 1/4 个窗口。
- **类目轴的「窗口」是首尾两个类目，不是整个 `domain`**（2026-09-21 修，别改回去）：
  `norm.xAxis.domain` 对类目轴是**窗口内的整串类目**（窗口里 120 根就是 120 项），
  只有连续轴才是 `[min, max]` 两项。平移的取窗口（`currentXWindow`）与位移计算
  （`shiftDomain` 的 band 分支，全集要用 `host.fullDomain('x')`）都必须按这个来。
  早先这两处都当成「两项」/「全集」，合起来就是**类目轴横向平移整条分支失效**，
  而纵向照常 —— 表现是「能上下拖、不能左右拖」，非常容易误判成配置问题。
  引擎自己的平移用例用的是**数值轴**，所以一直没照到类目轴这条路径。
  回归点：`chart.test.ts` 的「pans the domain on a category axis」。
- **类目轴的窗口越出数据时，要「贴边滑」，不许放大成整段**（2026-09-21 修，别改回去）：
  类目轴的窗口是一串**必须真实存在的 key**，端点 not found 时早先退化成
  `from = 0` / `to = length-1` —— 那是**整段数据**。多 pane 联动时这一条非常致命：
  某一格的系列类目比别人短（例如尾巴上有一段没有数据的空档），联动过来的窗口在那里
  找不到右端 key，于是那格当场被拉成整幅（实测：K 线图拖到最新数据右边，量图被拉成整幅）。
  现在的规则：一端越界 → 整窗贴着数据边缘滑、**跨度按当前窗口（`internal.domain.length - 1`）
  保持不变**；两端都越界（这张图表达不出来）→ **保持原窗口**，宁可这一帧不动，
  也不能跳到整段。回归点：`chart.test.ts` 的「clamps a category window that runs past the data」。
- **缩放有上下限，口径是「每根多少像素」**（2026-09-21 加，别改回去）：`interaction.zoom.minBarSpacing`
  （默认 0.5px/根）/ `maxBarSpacing`（默认 0 = 自动 → 绘图区宽度的一半，等价「一屏最少两根」），
  实现在 `util/zoomLimit.ts`（`clampBarCount` / `barCountRange`）。
  为什么不能用「占数据域的百分之几」：那个比例会随**图上载入了多少根**漂移。K 线页实测：
  缩到底到过 **0.24px/根**（一根占不到一个像素，整片糊成色带），放大那头卡在「数据域 5%」，
  载入根数一变限制就跟着变。改成 px/根 之后：缩到底 = 0.5px/根（形状还看得出来），
  放到头 = 半幅一根（3 根左右铺满）。
  限制**只约束手势缩放**（`source === 'zoom' | 'brush'`）：滚轮那条路自己算的时候就夹过
  （`zoomDomain` 的 band 分支），`clampAxisDomain` 里再兜一层别的入口；程序化 `setDomain`
  与联动回显（`source: 'api' | 'link'`）**不受限** —— 「回到最新」钉最后 count 根必须指哪打哪，
  联动要的是两张图窗口严格一致。回归点：`interaction/zoom-limit.test.ts`。
- **x 轴标签抽稀只有一处**（2026-09-21 修，别改回去）：`buildAxisLayout` 出表（`thinXAxisLabels`），
  `Axis` 组件只按 `axisLayout.labels[i] === ''` 决定画不画。三件事一起记住：
  1. **间距要用真实值**，不许给 `Math.max(1, slot)` 这类地板：间距 0.24px 时它按 1px 算，
     步长从「380 根一跳」变成「88 根一跳」，实测 3565 根时画了 42 个标签、79.5px 宽的标签
     按 20.7px 的间隔排出去 → 末端糊成一条色带。
  2. **要按绘图区宽度算**，不是画布宽度：比例尺是 `computeLayout` 开头用画布宽度建的
     （那时 y 轴占位还没定），用画布宽度会把可用宽度多算 7%~11%，两个标签刚好贴住。
     所以抽稀挪到绘图区算完之后。
  3. **首末标签放不下就整颗丢掉**，不往里推 —— 推右会压住邻居（实测左端标签推 27px
    正好盖住第二个标签的开头）。
  4. **垂直网格线（`grid.x`）读的也是这张表**（`labels[i] === ''` 的不要），不是
    `scale.ticks(5)` —— 类目轴的 `ticks()` 无视参数、返回整个 domain，那样打开 `grid.x`
    是每个类目一条线（120 根 = 120 条，实测就是一片栅栏）。所以 **`show: false` 的 x 轴
    也要出这张表**（只是 `labelWidth/Height` 归零、Axis 不画）：多 pane 里上面几块常藏掉
    x 轴，网格却要和下面那块对齐成方格。
  回归点：`components/axis-labels.test.ts`（盯真画出去的 `lastTicks[].drawn`）、
  `layout/layout.test.ts`（盯间距）、`chart/grid-x.test.ts`（盯网格与标签同一批位置，
  含隐藏轴的两种情形）。
- **悬停的三条铁律**（2026-09-15 / 2026-09-21 修，别改回去）：
  1. **画布量不到尺寸（`canvasWidth/Height` 为 0）＝ 指针不在本图上，判 `false`**。
     引擎的原生监听挂在 **window** 上，同一页里每张图都会收到整页的事件，`isOverCanvas`
     是唯一的"这事件不属于我"闸门。切页时被 `display:none` 藏起来的图尺寸为 0，早先这里
     返回 `true`（"尺寸未知就当指针在上面"），于是**隐藏中的图会把全页的移动都吃下来**，
     在错误坐标上锁住一个悬停；等它显示出来，`refreshHover()` 把这个陈旧悬停重新解析一遍，
     画面上就凭空多出一个**没人悬停却擦不掉的提示框 + 十字准星**（切页必现）。
  2. **指针离开画布要主动 `setHover(null)`，不能只是"忽略这次事件"**。
     画布外不再产生让本图重新取悬停的坐标，只 return 的话提示框会一直挂在画面上
     （用户没有任何办法弄掉）。回归点：`tests/interaction/isolation.test.ts` 里
     「clears its own hover when the pointer leaves the canvas」与
     「never treats a not-laid-out canvas (display:none) as hovered」。
  3. **指针只能收自己放上去的悬停**（`controller.externalHover`），
     外部（`showHoverAtValue` / 联动回显）放上来的由放它的那一方收回。
     上面第 1 条说明一次 mousemove 会派发到整页每一张图：被联动**回显**出悬停的图
     本身并没有指针悬停，它判定"指针不在我身上"就会把回显删掉 —— 三块 pane 的 K 线图
     实测：竖线永远只在指针所在的那一块出现，跨 pane 的十字准星根本做不出来。
     回归点：「keeps an externally mirrored hover when the pointer is outside its canvas」。
     配套的还有 `ChartLink`：**回显之死不是"离开"**，只有源头图自己发的 `item:leave`
     才许清别人（`link.test.ts` 的「keeps the source hover when a linked chart drops
     its echoed hover」）。

## 分支与发版约定（家族铁律，2026-09-13 确立）

- **开发**：在临时分支（或 `dev`）上做；`main` 只做集成与发版。
- **发版前**：必须先把开发分支合并进 `main`，**再从 `main` 发版**（跑门禁 → `npm publish`）。
- **禁止**：直接在 `main` 上写实现；也禁止只把改动留在临时分支 / `dev` 而让 `main` 停在旧版本。
- **远端默认分支**必须指向 `main`，且发版后它与开发主线内容一致（否则仓库首页显示旧代码）。
- 本仓主线名：`main`（Gitee `origin` + GitHub `github-origin`，两处都要推）。

## 测试约定

- `npm test` 跑 jest（jsdom + `tests/setup/canvas-env.ts` 提供的 Canvas 2D 桩）。
  **不要 mock 引擎**：集成测试走真实渲染 → 真实命中测试 → 真实事件派发，
  这样才能抓到「渲染与命中不一致」「多图串扰」这类只在真实链路上暴露的问题。
- jsdom 环境需要补 `crypto.randomUUID`（引擎用它生成组件 id），已放在 setup 里。
- 交互测试直接调 `controller.handlePointerMove/Down/Up/Click/Wheel/KeyDown`（入参是画布 CSS 像素），
  不需要合成 DOM 事件；需要真实浏览器行为时用 `examples/` + Playwright 手工验证。
- 新增能力时同步补三类用例：纯函数（scale/normalize/layout）、组件命中（series）、端到端交互（chart）。

### ⚠️ `npm publish` 报成功 ≠ 包已经可用（2026-09-23 实测）

发布 0.30.2 时踩到：`npm publish` 打印了 `+ @damoqiongqiu/ice-chart@0.30.2`，但紧接着
`npm view @damoqiongqiu/ice-chart version` 仍是旧版本、tarball 直连 **404**。这是 npm 的
**发布后异步处理**（输出里那句 "may take a few minutes to become available"）—— 本仓这次约
**90 秒**后 packument 里才出现新版本。三条纪律：

1. **别急着重发**：看到 404 再来一次 `npm publish`，是在赌一个「重复发布」的报错。
   先等 1~2 分钟。
2. **核验以 packument 为准，不以 `npm view` 为准**（`npm view` 自带缓存，在落地窗口里
   它和「发布失败」长得一模一样）：

   ```bash
   curl -s "https://registry.npmjs.org/@damoqiongqiu%2Fice-chart" \
     | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);console.log(d["dist-tags"], Object.keys(d.versions).slice(-3))})'
   ```

3. tag 与双推可以照旧先做（不受这个窗口影响），但**「发版完成」的结论要等 packument 上
   看得到、且 `dist-tags.latest` 指过去之后**才下。

## 提交前自检

```bash
npm run verify   # lint → types:check → build → jest
```

改动渲染或交互后，建议再手工跑一次 `npm run examples:serve`，用浏览器确认视觉与交互。
视觉 / 交互改动更严格的做法是跑审计脚本：

```bash
npm run build && npm run examples:prepare && node scripts/serve-examples.cjs &
npm run audit:interactions -- ./.audit
```

它会对 **30 个示例页**逐个跑真实交互并逐步断言几何关系（2026-09-17 实测：334 步、0 个问题）
（提示框不越界、不压坐标轴标签/图例，
高亮在绘图区内、没有饱和色墨迹跑到坐标轴带上）。新增交互能力时请同步补一步，
新增示例页时请同步加进两个脚本的 `pages` 列表，否则这个门禁覆盖不到。

README 的截图由 `scripts/readme-shots.mjs` 生成（同一套浏览器环境，产物在 `docs/screenshots/`）：
改了主题 / 大屏配色 / 示例布局之后请重跑，别让文档里的图停在旧版本。

## 视觉基调

- **数据域留白放在 `niceDomain` 之后**（`padDomain`）：先留白会把数据最大值 40 抬到 42、再取整变成 50，
  白多一整格，而且会多触发一次「数据更新时的域过渡」（实测弄挂过一条动画用例）。
  留白只加在「数据自己说了算」的那一侧：显式 `min`/`max` 不动、柱形/面积的 0 基线不动、log 轴不做。
- **交互产生的窗口要有兜底**：滚轮有 `minSpan`，滑块当初什么都没有 —— 实测拖到最右时窗口落进取整出来的
  空白区，可视点 0 个、整条曲线消失（用户描述为「缩成一团」）。现在统一要求**至少盖住 2 个数据点**
  （类目轴至少 2 个类目、数据只有 2 个点时放宽到 1 个）。兜底只作用于用户手势；
  `setDomainFromFractions()` 这类**公共映射函数保持精确**（用 `guard` 参数区分，别把守卫塞进语义里）。
- **审计要量「系列几何」，不要扫像素**：深色主题的坐标轴线本身就是彩色（`rgba(124,140,255,…)`），
  拿「饱和墨迹」当系列会被它污染 —— 实测出现 -395px 这种离谱的越界值。
  系列包围盒直接用 `seriesComponents[].pixelAt(i)` + 组件盒偏移算，干净且精确。

- **主题写入契约（引擎 2.14 起）**：图表的主题补丁走 `ice.setThemePatch('ice-chart', patch)`，
  **不要**再调 `ice.setTheme()` —— `setTheme` 写的是"基座"（UI 主题的地盘），两边都写基座就是"后写的赢"：
  应用切 UI 主题会把图表主题抹掉，图表推主题会把 UI 主题抹掉。补丁层让两层互不覆盖、调用顺序无关。
  （`theme:'auto'` 例外：它本来就是"跟随引擎"，不推主题，见 `ICEChart` 里的注释。）
- 默认主题 = **Bootstrap 5**（`src/theme/chartTheme.ts` 的 `BOOTSTRAP_TOKENS`）。
  新增组件取色一律从主题里取，不要写死色值；示例页 CSS 也用 Bootstrap 变量。
  例外：**压在图形上的文字描边**走 `theme.labelHaloColor`（浅色 = 白、深色 = 深色）——
  写死白色会在深色大屏里糊成一团（桑基节点名实测完全不可读）。
  注意区分「文字描边」与「图形描边」：节点边框、扇形分隔线是图形的一部分，保持白色。
- **流动虚线这类「按图元尺寸缩放」的装饰要有像素上限**：桑基连线宽 40~60px 时，
  `link.width * 0.28` 的虚线会变成一串白珠子（大屏实测）。装饰性线宽一律
  `Math.min(上限, 比例 * 尺寸)`，别让它盖住内容本身。
- **坐标轴文字与轴名称都必须是近灰**（`axisLabelColor` **和** `subTextColor`）：审计脚本用「通道极差 > 45 视为饱和墨迹」判断
  「图形画到坐标轴上」。大屏配色里把轴文字调成偏蓝的 `#7d93b5`（极差 56）就会被误判，
  实测直接报 9 处 ink-over-axis。轴文字用 `#8b98a9` 这类近灰即可；准星标签用深底 + 亮字，
  别用亮色底。

## 大屏（`examples/dashboard*.html` + `examples/assets/dash-kit.js`）

- **固定 12 列栅格**，不做响应式缩放：canvas 被 CSS 缩放后，引擎用
  `clientX - rect.left`（只按 dpr 换算）算坐标，命中检测会整体偏移。
  设计宽 1572 = 12 × 120 + 11 × 12；面板宽 = 列宽整数倍 + 同间距；画布宽 = 面板宽 − 16 − 2。
  「有没有对齐」用硬指标验：面板左边缘的**去重集合**应该只有 4 个值（相差 3 列），
  画布左右留白相等。
- **公共部分一律走 `DashKit`**（注入 CSS / 按栅格出面板 HTML / 主循环 / `chartTheme` 包主题），
  页面里只留三样东西：配色变量、面板清单、`tick` 里的数据怎么动。新增一个大屏 = 新增一个 HTML，
  不要把 CSS 与循环再抄一遍；`DashKit.loop()` 会把控制器挂到 `window.__dashLoop`，
  「像素缓存新鲜度」检测靠它暂停数据流（否则「缓存落后一帧」会被误判成缓存陈旧）。
- 每个页面自己定义一套**视觉身份**（`--dk-bg/--dk-panel/--dk-accent/--dk-glow...`）：
  底色跟着主色走（青 / 青绿 / 琥珀 / 蓝紫 / 橙红 / 紫），面板与描边都从主色派生。
  底色与主色不一致（比如青底配橙主色）会立刻显得廉价。
- 页面必须 `DashKit.wire({ main, charts })` 暴露 `window.__chart` / `window.__charts`，
  并在底部留 `#snapshot-panel` —— 审计脚本与序列化面板都按这套约定取图。
- 大屏的视觉基调在这里固化下来，照着做即可：近黑蓝底 + 单一强调色 + 卡片化面板
  （半透明深蓝渐变 + 1px 描边 + 四角 L 形亮角）+ 一条整宽的 KPI 分隔条 + 水位球这类标志性图形。
- 提示框 / 准星标签的摆放有硬性约束（见上一条审计）：**不许越出画布、不许压住坐标轴标签与图例**。
  改 `Tooltip.doRender` 的定位逻辑时务必重跑审计。
- 标签防重叠的既定策略：内部标签按相邻角度逐级外推半径，弧长放不下就不画（交给图例 + 提示框）；
  桑基节点名用白色描边保证压在连线上也可读。
- **「放得下才画」必须用 `measureTextWidth` 量真实文本宽度，不能只按矩形尺寸猜**
  （`util/text.ts` 已有现成实现，饼图就是这么做的）。树图实测：占比每轮都在变，
  40~70px 的窄块里 4 个汉字照样溢出到隔壁块上；现在按主题字号试、逐级缩到 9px、仍放不下才不画。
- **改了 `ctx.textAlign` / `textBaseline` 的分支必须显式还原**：树图的父节点标签是左对齐的，
  改完没还原，后面的叶子标签就变成「从矩形中心往右排」（整体右移半个文本宽），
  宽块看不出来、窄块直接把字顶出画布 —— 这类「跨节点状态泄漏」在逐元素循环里最容易发生。
- **跟手的东西（准星 / 以后的游标类覆盖层）不许用「固定时长的补间」跟随**：
  指针是连续输入，每次 mousemove 都会重设目标，固定时长的补间会被反复重启 ——
  实测准星滞后 50~300px，数据流页面（每帧 `refreshHover()`）甚至**永不收敛**，
  用户看到的就是「线飘来飘去」。正确做法是**按距离给时长**（`crosshairGlideDuration`：
  5px/ms，上限 `crosshair.followDuration` 默认 90ms），小位移当帧落位、大跨度才有一段可见滑动；
  再加一条「目标没变就不重启补间」。
- **别把另一种动画的时长挪过来复用**：准星的跟随时长原本接的是 `animation.update.duration`
  （默认 420ms，那是「数据变化时图形怎么变」）。这种「看着相关、其实无关」的耦合是这次 bug 的根因；
  新增依赖时长的地方先问一句：这两件事真的同源吗？
- **圆形图的半径只按「形状」算，别挪别种的预留**：`gauge` / `liquid` 的文字都在图形内部
  （刻度贴弧、数值在圆心 / 球心），套用饼图那圈「引导线标签预留」会让半径只剩一半
  —— 实测仪表盘在 420×300 的画布里只画了 92px 直径。只有**标签画在图形外**的类型
  （带标签的饼图）才该预留外圈。
- **圆形/正方形图放进过宽的卡片必然留死区**：圆受较短边限制，`aspect: 'equal'` 的绘图区被压成正方形居中。
  排版时要么让卡片接近方形，要么把两张并排（迷你 MATLAB 的极坐标 + 参数曲线就是这么改的）。
  量化标准见 `scripts/audit-space.mjs`。
- **栅格类必须覆盖 1~12 列**：`dash-kit` 原本只定义 3~8、12，写 `dk-span9` 不会报错，
  而是退化成「自动占 1 列」，两块面板直接叠在同一个格子里（实测散点图压在玫瑰图上）。
  这类「没定义的类名静默降级」在 CSS 里很常见，宁可多写几行也要给全。
- **探针/截图脚本的视口宽度必须 ≥ 内容设计宽**：悬停实测原来用 1280 的视口，
  而大屏设计宽是 1572 —— 最右侧的面板在视口外，鼠标移过去不产生事件，
  探针会偶发报「hoverIndex: null」，看起来像图表坏了，其实是探针够不着。

## 虚拟（列存）系列（改数据点存储 / 命中路径前必读）

`series.virtual: true`（支持 `scatter` / `line` / `area` / `heatmap`）是「100 万点也要能拖」的那条路：
不建「每点一个 `DataPoint`」，只保留列。两类形态：

- **数值列**（scatter / line / area）：`SeriesColumns`（x / y（/ size）几条 `Float64Array`）；
- **稠密矩阵**（heatmap）：`SeriesGrid`（行列类目 + 行优先值矩阵，NaN = 空格）。
  热力图的收益有一半来自「承认它是矩阵」：**命中退化成类目查表 + 下标运算（O(1)）**，
  不再是逐格比矩形；亚像素时按**屏幕像素块聚合**（块内取最大值，热点不被抹平），
  聚合结果按几何键缓存。稀疏数据别开 virtual（归一化按密度报错）。

- **读点只有三个入口**：`pointCount`（数量）、`pointAt(i)`（按需合成，断点仍是 `null`）、
  标量访问器 `xValueAt / yValueAt / baseAt / topAt / sizeAt`（逐点绘制与插值的循环走这组）。
  **不许再写 `series.points[...]`**：虚拟系列的 `points` 是空的，直读会静默少画 / 提示框空；
  访问器闭包捕获的是**建系列时那一个数组**，要改点必须就地改，别给 `points` 重新赋值。
- **原始 `data` 会被释放**（这是省内存的大头，百万级元组自己就占 40~70MB）：归一化建完列
  就把 `option.series[i]` 换成不含 data 的副本。列存缓存在 `ICEChart.virtualColumns`
  （一次 `applyOption` 会归一化两遍，第二遍靠它复用）。
- **不物化按点缓存**：`pixels` / `effective` / `itemProgress` 光缓存就是 40MB，
  所以虚拟系列的像素与命中都从「列 + 同一份比例尺」现算。共用内核在 `SeriesBase`
  （`syncVirtualMeta` / `virtualVisibleWindow` / `virtualPixelAt` / `virtualNearestIndexAtX`），
  各类型的差异只在「怎么把窗口画出来」：散点是密度抽稀后逐点画，
  折线 / 面积按像素列分桶保留**首 / 最低 / 最高 / 末**（折线丢极值就是撒谎），
  热力图走矩阵那条（窗口裁剪 + 像素块聚合）。
  这是铁律 2 唯一的例外，理由见铁律 2。
- **冷路径同样不许全量扫**：能问列的就别遍历点。两条已经修过的：
  ① 交互窗口兜底（`numericXProbe`）原来把全部 x 值去重排序，100 万点每滚一次轮 60ms，
  现在在单调列上二分；② 无障碍数据表默认封顶 200 行（`A11yTreeOptions.maxTableRows`），
  超限按等步长抽样并在 caption 里写明（少给内容必须说出来）。
  新增「看一眼就完」的冷路径时先问一句：这件事需要知道**每一个点**吗？
- **每 tick 的地板在流水线，不在存储**（2026-09-22 记录）：列存 / 环形把存储压到 O(1)
  （实测 0.13ms/tick），剩下的成本是「数据一变就重跑归一化 + 布局 + 同步组件」这条流水线
  （1 万根窗口 ~1.1ms、10 万根 ~1.6ms）。**要再往下压得做增量归一化 / 增量布局** ——
  那是独立的一项，施工图与验收在 `plans/incremental-pipeline.md`，尺子是
  `scripts/measure-pipeline.mjs`。别把「追加还是 O(n)」当成 bug 顺手乱改：
  归一化是纯函数这条契约不能破。
   ⚠️ **有视窗的滚动看盘是另一档**（2026-09-24 第 3 期）：`measure-pipeline` 新增的
   「环形 + 视窗」档位原来比「环形」还慢（10 万点 1.6ms vs 0.6ms）—— 因为类目查表口只在
   「域=整张表」时才交出去，**一被视窗裁剪就退回自建索引表**（每帧为 10 万类目重建一张 Map）。
   现在查表口连同 `categoryOffset`（窗口起点在整张表里的下标）一起交，`BandScale` 用
   「全表下标 − 偏移」换算窗口内下标：10 万点 **1.6ms → 0.3ms**、1 万点 0.5 → 0.2ms。
   加新轴 / 新比例尺时的自查：**你的域是不是「某张增量表的一段」？是的话把偏移一起带上。**
- **亿级数据用分块按需加载**（`SeriesChunks`）：`data: { sizes, rangeOf, yDomain, loadChunk }`，
  只驻留可见窗口覆盖的块（`maxResidentChunks`，LRU）。三条纪律：
  ① `rangeOf` / `yDomain` **必须声明式**（前者让窗口定位不必先加载，后者让坐标轴不随加载漂移）；
  ② 窗口覆盖的块远多于驻留预算时**按预算均匀取样**，不能对窗口内每块都发请求
     （实测：10 亿点全量视图覆盖 1 万块，全请求 = 1 万次加载 / 初始化 22 秒；
     取样后 3 次 / 3ms —— 与散点折线的密度抽稀同一条思路）；
  ③ 分块系列的**最近邻不能在全量下标上二分**（未驻留区间的 `xValueAt` 是 undefined，
     会一路走到头、命中判空）：先用 x 值定位到块，再在驻留块内二分。
- **列可以交给引擎的虚拟子源**：`chart.createVirtualSource(seriesId)` 返回
  `VirtualChildSource`（坐标是组件本地 = 绘图区像素），`ICEVirtualLayer` 摆在绘图区上即可；
  数据**不复制**，窗口裁剪 / 批量落墨 / 命中归引擎，白拿「命中即物化」/ SVG 导出 /
  对齐参考线。两点注意：`forEachInBox` 是 O(窗口项数)（100 万项全窗约 30ms，按需调用，
  别每帧全窗扫）；`materialize` 只造组件，挂树由调用方做（引擎定的口径）。
- **自定义系列也能 `virtual`（惰性原始点，`SeriesRawPoints`）**：`scatter/line/area/heatmap`
  之外的任何类型（含 `registerSeriesType` 注册的）开 `virtual: true` 走这条 ——
  **原始数据按引用保留**（组件按自己的字段解析、提示框照旧有 `params.data`），
  省掉的是「每点一个 `DataPoint`」；取点规则与普通系列**共用 `readGenericPoint`**
  （两边的 `xValue/y/name/size` 必须逐字一致，否则提示框与命中会分叉）。
  三条别踩：① **像素缓存照旧建**（自定义系列的 `doRender` 通常直接读 `this.pixels`，
     不建缓存会让它静默不画）—— 数值列 / 矩阵才省像素；
  ② 追加：不给窗口就**原地 push**（调用方那个数组也跟着长），给了 `maxPoints` 就转成
     **原始环**（`capacity`/`start`，滚动窗口 O(1)/次，不用 `shift()` 搬 10 万个元素）；
  ③ 快照：普通形态数据还在 option 里（**能进快照**），转成环之后归存储所有、
     option 里被摘掉 → `restore()` 显式报错（与数值列系列同一条纪律）。
     门禁：`tests/chart/virtual-custom-series.test.ts`（渲染 / 命中 / 两种追加 / 环的绕回 / 快照）。
- **代价要一直保持显式**（不许静默降级）：快照里没有数据 → `restore()` 直接报错；
  `appendData` 报错（改 `setData`）；数值列系列要数值型 x（类目轴、堆叠一律抛错）、
  虚拟热力图反而要求类目轴且密度够高（太稀疏报错）。相应的门禁：
  `tests/option/normalize.test.ts`、`tests/components/virtual-*.test.ts`、`tests/chart/virtual-series.test.ts`。
- 示例页：`examples/large-data-virtual-series.html`（100 万点，散点 + 折线共用一份列）、
  `examples/heatmap.html`（第二张图是 100 万格矩阵热力图）、
  `examples/live-stream.html`（第二张图是窗口 2 万点的列存实时流）、
  `examples/large-data-virtual-series.html` 的第三张图（同一份列喂给引擎虚拟层）。

## 密度：亚像素下**不要逐根画**（2026-09-24 首轮补全）

远景（一屏几千根以上）里图元的物理尺寸已经小于 1 像素，**画出来也分不出来** ——
这时「逐根画」既是白烧 CPU，也是在给画布叠无效像素。三种系列各有一条密度策略，
口径统一：**按像素列聚合/抽样，落墨量与像素数同级；命中与提示框仍走全量数据**。

| 类型 | 规则 | 实现 |
|---|---|---|
| 散点 | 每像素列约 2 点（`stride`） | `ScatterSeries` 的密度抽稀（虚拟 / 普通两条路同规则） |
| 折线 / 面积 | 每像素列最多 4 个点（首 / 最低 / 最高 / 末），每列 8 个候选 | `LineSeries.virtualRenderSequence`；普通系列另有 LTTB 抽稀 |
| **柱子** | 每像素列一根**聚合矩形**（该列 `[min(base,值), max(base,值)]` 的并集），每列最多 8 个候选 | `BarSeries.drawDense`（`shouldDrawDense`：类目轴 + 每像素 > 2 根） |

配套的三条纪律：

1. **稠密模式不建「每根一个」的像素缓存**：柱子 100 万根时 `rebuildPixels` 要跑 5.6ms/帧，
   而稠密绘制根本用不到它（命中改按 x 比例反推下标 + 验邻域几根，
   `pixelAt` 走虚拟系列的按需分支）。非稠密路径**一个字节都没改**。
2. **渐变只在看得见的时候建**：每根柱子 `createLinearGradient` + 2 个色停，几万根时纯浪费
   （实测 1M 根 180ms/帧）。现在柱高 < 3 设备像素就用纯色 —— 那个尺寸下渐变肉眼无差。
3. **对比度靠聚合、不靠抽样掉极值**：柱子保留列内极值区间（尖峰不会被抽掉），
   折线保留每列首/最低/最高/末（"折线丢极值就是撒谎"同一条理由）。
   真正的抽样只发生在**每列候选数**上（≤8），而那个密度下列内几根本来就分不出来。

实测（1M 根窗口、真机 Chromium、宿主是 ice-trading-chart 的流式页）：

| 场景 | 前 | 后 |
|---|---|---|
| 1M 根 **柱子 + 均线** | **3516 ms/帧**（≈0.3fps） | **16.7 ms/帧**（60fps） |
| 1M 根 柱子 | 417 ms/帧 | 16.7 ms/帧 |
| 1M 根 K 线（自定义系列自带的压缩模式，见 ice-trading-chart） | 整帧 27% 花在逐根聚合 | 同一条线，成本 ≈ 1/13 |

### 类目表：多个来源但**逐项相同**时直接复用（同一轮）

滚动看盘里 K 线 / 量柱 / 均线的 x 本来就是同一批，而 `buildXDomain` 的多来源合并
要对**每一张表**跑一遍 `String()` + 哈希（100 万 × 2 实测约 200ms/次）。
现在先做一次**逐项同一性**（`!==`，不做字符串转换）的精确比较：通过就复用第一张表
（连 `rawCategoryIndex` 查表口一起，视窗裁剪下的偏移也照旧），任何一处不同就退回合并 ——
两条路的结论逐项一致（`1` 与 `'1'` 这种「字符串相等但类型不同」会走合并那条，语义不变）。

## 序列化契约（改持久化相关代码前必读）

- **唯一事实来源是 option 快照**：`{ version, option, view, hidden, hiddenSlices }`。
  引擎组件树（`ice.toJSONString()`）**不是**图表的持久化格式：它只有几何与样式，
  没有比例尺 / 数据点 / 命中缓存，反序列化回来是空壳。不要把「组件树能存下来」
  当成「图表能存下来」，也不要把语义数据塞进组件 `state`。
- 往返必须同时满足两条硬约束：**幂等**（还原后再导出与原文字节一致）与
  **像素一致**（两张画布 `toDataURL()` 相同）。测试见 `tests/chart/serialization.test.ts`，
  浏览器现场比对见 `examples/serialize.html`。
- 函数字段（formatter 等）不进 JSON，靠 `optionPatch` 在还原时补。
  `mergeOptionPatch` 里「带 id 的补丁只按 id 合并」这条规则不能回退 ——
  否则补丁的第 N 条会被误合并到快照的第 N 条上（曾把 A 系列改名成 B）。
- 快照带 `version`；加载更高版本必须显式报错，不要静默降级。

## 新增一种图表类型的固定动作（照这个清单走，别漏）

1. `types.ts`：加 `SeriesType`，写该类型需要的 `XxxOption`（配色、尺寸、角度等）。
2. `internal.ts`：如果这个类型引入了新的**场景**（不是直角坐标），把它加进 `kind`，并在
   `NormalizedOption` 上挂一个配置字段。
3. `option/normalize.ts`：数据点归一化（`buildPoints` 里加分支）、场景判定、数据域。
   纯几何能算的（五数概括、累计 base/top）也放在这里，保证可单测。
4. 组件 `src/components/series/XxxSeries.ts`：
   - `seriesType`；
   - 覆盖 `paintPad()`（脏矩形留白）；
   - `rebuildPixels()` 填 `this.pixels`（**必须是绘制与命中共用的同一份几何**）；
     缓存键走 `this.buildSeriesKey([...])`（自动带坐标系指纹与动画进度）；
   - `hitTestIndex(lx, ly)`（本地坐标，返回数据下标）；
   - `doRender()`（本地坐标绘制；直角坐标系列记得 `clipToBox = true`）；
   - 需要矩形高亮就实现 `highlightRectAt(index)`。
   - 悬停反馈：几何能安全变形的用 `hoverBoost()`（记得命中判定同步放大，
     否则指针停在放大后的边缘会「忽进忽出」）；图元紧挨着的用 `drawHoverOverlay()`（只叠加不改几何）。
5. `createSeriesComponent` 加 case；`src/components/series/index.ts` 与 `src/index.ts` 导出。
6. `ICEChart.syncSeries` 里给该类型分派 coord；非直角场景要在 `syncComponents` 里隐藏坐标轴/网格。
7. `InteractionController.buildTooltipContent` 加该类型的提示框分支（别的类型都有，别让它退化成默认格式）。
8. 测试三类：纯函数（归一化 / 几何）、组件命中、引擎集成（真实 hitTest + 事件）；
   再加一个示例页并把页面名加进 `scripts/audit-interactions.mjs` 的 pages 列表。

> 坐标系两种风格的取舍：`function` / `parametric` 走**直角坐标**（`kind: 'cartesian'`），
> 因此不需要新场景；但它们的「数据点」是表达式现算的，归一化里的
> `buildCurvePoints` / `applyCurveDomain` 要负责给 x / y 数据域提供取值
> （参数曲线的 x 域来自 `domainXValues`，y 域来自 `domainValues`）。

## 动画（改动画相关代码前必读）

- **三段式配置**：`option.animation.enter / update / highlight`，归一化在 `normalizeAnimation()`；
  扁平写法（`duration/easing/stagger`）等价于 `enter`。新增动画能力请接到这套配置上，不要另起一套参数。
- **错峰靠「每项自己的进度」**：`SeriesBase.itemProgress`（`computeItemProgress()` / `progressFor()`），
  不要为每个数据点建一个组件（那样组件数会爆）。
- **画布缓存键必须带动画进度**：任何覆写 `rebuildPixels` 的系列，键一律走
  `this.buildSeriesKey([...几何参数])` —— 它会把 `progress` / 阶段 / 错峰拼进去。
  这条曾被六个系列同时违反，表现为「动画只动第一帧，之后冻住」（外部完全看不出来，只有逐帧采样才发现）。
- **缓存键还必须带坐标系指纹**：`buildSeriesKey` 现在会自动拼上「绘图区矩形 + x/y 比例尺的数据域」。
  只拼「绘图区 + 某一个轴」的键在缩放 / 数据域过渡 / 轴类目变化之后不会失效，
  于是 `pixels` 停在旧位置 —— **渲染几何（重算）与命中/高亮锚点几何（pixels）分叉**，
  表现是「悬停高亮画在别处」，看起来像交互 bug，实际是缓存 bug。
  门禁：`tests/components/pixel-freshness.test.ts`（清键重算，两次像素必须一致）。
- **交互验证必须探测渲染态**：`hoverIndex` 有值只说明状态对了，不代表画出来了。
  要断言 `barDrawRectAt()` / `highlightRectAt()` / `panelOpacity()` / `state.axisX` 这类
  「真正参与绘制的值」。也不要直接读 `layout[].rect`（那是新布局，不是动画中的渲染值）。
- **悬停状态里的系列对象会过期**：`rebuild()` 每次都重建 norm，悬停里存的是上一轮的系列对象。
  `HitResolver.seriesComponentOf()` 有 id 兜底、`refreshHover()` 从当前 norm 取新系列 —— 
  否则「数据更新时悬停被清掉」（实时刷新的仪表盘 1.6s 掉一次，肉眼可见）。
- **`refreshHover` 不要按「场景类型」提前清空悬停**：非直角坐标（雷达 / 饼图）也可能出现
  `axis` 悬停（同一个指标 / 同一个切片下标的对比是有意义的），以前对非 cartesian 直接
  `setHover(null)` —— 大屏上的雷达每 0.5s 更新一次数据，悬停反馈因此永远起不来。
  现在所有场景都按 x 值重新解析「列」，只有直角坐标才做「列像素是否还在绘图区内」的检查。
- **域过渡只对直角坐标启动**：极坐标 / 雷达 / 仪表盘 / 水位 / 树图不按 y 轴排布，
  给它们启动 y 域过渡 = 每帧一次全量重建，而且因为 `setData` 会重置系列进度，
  过渡**永远到不了终点**（大屏实测 5 张图常驻重建循环）。
- **只由 `progress` 推导几何的图（gauge / liquid），更新动画要从「当前渲染值」出发**：
  起点恒为最小值/0 时，高频 `setData`（监控 130ms 一次）会让动画永远跑不完 ——
  实测 CPU 79.9% 而指针停在 10、水面停在 27%。起点捕获**不要**受 `preserveAnimation` 影响
  （那个参数只管 `fromEffective` 值插值）。
- **`finishAnimations()` 只能收尾一次性补间**：`__` 前缀的是 `keepAnimating` 的循环补间
  （蚂蚁线 / 桑基流动 / 水位波浪），收尾会永久冻住它们。
- **改了图元的悬停几何，要同步改高亮描边**：柱形悬停会变长，描边若还用基础矩形，
  就会横在柱子中间（看着像接缝）。描边一律取「终态绘制矩形」并与绘图区求交。
- **入场动画只在 `enter` 阶段做「画出来」这类形态**：`isEntering()` 判断。
  更新阶段截断折线会变成「重画」而不是「折点动起来」。
- **坐标轴 / 网格线的过渡必须共享同一份渲染位置**：刻度位置由 `Axis` 算（`renderedTickPos`），
  网格线**读坐标轴**而不是自己重算 `scale.map()` —— 否则动画期间标签在滑、网格线在跳。
  网格自己不产生位移，只需要一条等长的补间当「脏驱动」（`GridLines.syncTicks()`）。
  判断「要不要过渡」只看刻度集合有没有变，缩放 / 平移 / 数据更新 / resize 都自动覆盖。
- **对同一批刻度做过渡时，插值「起点 + 扫过角」，不要分别插值两个端点**：
  饼图隐藏扇区时端点各自走最短路径，会让扇形中途先变宽再收拢（看起来像抖了一下）。
- **显隐切换现在是动画而不是瞬跳**：`toggleSeries` / `toggleSlice` 传 `animate: true`，
  新类型的显隐重排要按同一节奏接上（饼图用 `sliceFrom`、漏斗用 `stageFrom`，都按数据下标对齐）。
- **`finishAnimations()` 要收尾所有补间组件**（系列 / 坐标轴 / 网格 / 准星 / 提示框）：
  只收系列的话，截图与「动效偏好 = instant」会拍到半路状态。
- **写 `props.animations` 一律「复制 + 合并」**：组件上可能同时跑着多个补间
  （系列 `progress` / 悬停 `highlightT` / 扫动 `__tick`）。`playStage` 曾用整体替换，
  把悬停反馈悄悄冲掉 —— 数据流场景（每帧 appendData 重播 update）里 `highlightT` 永远到不了 1，
  实测卡在 0.16，悬停探针判失败。序列化那条铁律（冻结对象不能原地改）要求复制，
  这条要求**合并**，两条都要满足。

## 实时数据流（改 `appendData` 前必读）

- **滑动窗口的下标会整体前移**，所以追加路径**默认不做值插值**（`animate: false`）：
  插值会把每个点插向「邻居的值」。要插值就显式 `animate: true`（窗口不滑动时才有意义）。
- 推送频率就是流畅度：60Hz 推送 = 60fps 滚动。实测成本（2 系列 / 每次各追加 1 点）：
  120 点窗口 **1.6ms/tick**、600 点 4.9ms、1500 点 11ms（成本随窗口近似线性，因为每 tick 都会
  归一化 + 布局 + 重建像素）。监控类示例用 120~300 点窗口最划算。
- **虚拟（列存）系列的追加走环形缓冲**（`appendData(id, items, { maxPoints: 窗口 })`）：
  容量就是滑动窗口大小，满了覆盖最老的；每次追加是「写 1 个槽位 + 挪一次起点」，
  **不 concat、不重建数据点对象、不重建像素**。实测同一个 API：
  窗口 1500 → 0.10ms/次、2 万 → 0.20ms、**10 万 → 0.40ms**（几乎与窗口无关）；
  普通路径同口径是 0.30 / 0.80 / **5.80ms**（p95 15.1ms，一帧预算就没了）。
  两处纪律：① 只有**数值列**系列能流式（热力图是矩阵，追加没有「下一格」这种语义，会报错）；
  ② 环形缓冲的**物理下标 ≠ 逻辑下标**，一律走 `xValueAt` / `pointAt` 读，
  不许直读 `ring.x[i]`（绕回之后那就是别的点的值）。
  数据域每次追加重算一趟（窗口几千点约 0.02ms，10 万点约 0.3ms）——
  真要做百万级窗口的实时流，该换的是「分块 + 增量域」，而不是在这里加复杂度。
- `appendData`/`setData` 会**就地改传入的 option**（`series[i].data = ...`），
  测试与调用方要传自己的副本，否则模块级常量会在用例之间互相污染（踩过）。
- **数据域要跟动画一起过渡**：更新时 y 轴数据域常变（最大值 50 → 40），域瞬跳会让图形先蹦一下。
  `ICEChart.domainTransition` + `stepDomainTransition()` 每帧按系列进度插值数据域；
  过渡期间同步组件必须传 `preserveAnimation=true`（只换 series 引用，不清 `fromEffective`），
  否则值插值会断。
- **`finishAnimations()` 必须同时取消引擎补间**（把 `props.animations[*].finished = true` 并从
  AnimationManager 摘掉），否则下一帧引擎又把 progress 写回去。
- **动效偏好是产品能力**：`setMotionPreference('auto' | 'instant' | 'full')`，
  `auto` 跟随 `prefers-reduced-motion`。测试通过 `tests/setup/canvas-env.ts` 全局设为 `instant`，
  这样既有断言确定、也快；动画的时序行为另有 `tests/chart/animation.test.ts` 覆盖。
- **不要把动画放到「不可见的驱动组件」上**：实测证明引擎补间期间的 `interactive=false`
  只存在于同步块内，动画与命中互不影响。
- **浏览器实测门禁**：`npm run audit:hover -- ./.hover-sweep`
  会逐类型、逐数据点真实悬停（15 种类型 / 86 个探针），断言反馈动画到位、几何不越界、
  像素缓存新鲜、无 console 报错，并按「图 × 系列」截图供人工复核。
  示例页里的 `setInterval` 实时数据（仪表盘示例）要留意：探针必须等一次刷新窗口，
  否则会把「数据更新」误判成「悬停丢失」。

## 函数绘图（`function` / `parametric`，改动前必读）

- **几何来自表达式，不是数据点**：`CurveSeriesBase.rebuildPixels` 现场求值；
  `series.points` 仍然存在（提示框 / 高亮 / 键盘导航的锚点），但锚点的像素位置也由表达式算出，
  所以「画出来的曲线」与「点得到的点」不会分叉。
- **采样必须按可视区间做**：缩放后要重新采样（否则放大会看到折线被拉大）；
  自适应细分要有上限，极点附近会无限细分。断点写成 NaN，渲染按 NaN 分段（`tan(x)` 的竖直假线就是这么来的）。
- **y 轴自动贴合只在 `function` 上开**（`ICEChart.autoYCurve`）：参数曲线的几何固定，
  按可视窗口改 y 域只会让图乱跳。自动贴合时记得同步 `fullYDomains`（范围查询与 y 缩放夹取都读它）。
- **参数扫动的每帧重算走 `keepAnimating()`**：曲线是每帧重新求值的，缓存键必须带上参数值
  （`paramKey()`），否则曲线会冻在第一帧 —— 与「缓存键要带动画进度」是同一类坑。
- **表达式编译结果要缓存**：参数扫动时每帧上万次求值，`compileExpression` / `compileSampler`
  都带缓存并复用 scope；不要在采样循环里新建对象。
- **极坐标是参数曲线的简写**：`polarExpression`（r(θ)）在组件里展开成 `(r·cosθ, r·sinθ)`，
  **不要**为它新建场景或第二套采样 / 命中链路；网格（`PolarGrid`）画在直角坐标场景里，
  只在 `aspect: 'equal'` 时显示（否则圆是椭圆、网格对不上）。诊断要看 **r 本身**，
  拿派生的 x/y 判断会给出误导性提示。
- **画圆必须开 `aspect: 'equal'`**：直角坐标的绘图区是长方形，x / y 的单位长度天然不等
  （实测差 2.86 倍，圆会被看成椭圆）。等比坐标要**两件事一起做**：
  normalize 把两个轴的数据跨度拉齐（`applyEqualAspect`）+ 布局把绘图区收缩成正方形；
  只做一件都不成立。收敛判断放在 `ChartOption.aspect`，默认 `'auto'`（不影响既有图）。
- **表达式诊断要覆盖三层，并抑制级联**（`src/expr/diagnostics.ts`）：
  语法 → 静态（未定义变量 / 参数没用上）→ 运行（整段画不出来 / 输出恒定）。
  **未定义变量以前是静默 NaN**（曲线消失、用户只看到空白），现在必须报 error；
  但静态层已经报错时不要再跑运行层 —— 否则「b 没定义」会连带报「整段画不出来」，
  用户看到的是症状而不是根因。诊断只挂数据，永远不让图表抛异常。

## 已实现 / 未实现

已实现：直角坐标 / 极坐标（饼图、玫瑰图）/ 雷达图 / 桑基图；多 y 轴；dataZoom 滑块；
LTTB 降采样；无障碍数据表镜像；热力图、桑基图；箱线图、瀑布图、矩形树图、漏斗、仪表盘、水位球；
力导向关系图（**无底图**，节点可拖拽）；表达式绘图（`function` / 参数曲线 / 极坐标曲线）与表达式诊断。
标注（`option.annotation`：目标线 / 阈值线 / 异常点 / 目标区间 —— 声明式图层，不是新系列类型）。

仍未实现（改动前先确认是否要做）：

- 桑基节点拖拽重排与折叠；
- 数据 append 的增量绘制（现在是全量重建像素缓存）；
- y 方向的 dataZoom 滑块（`setAxisDomain` 可用，缺 UI）；
- 隐函数 / 等值线（`f(x,y) = 0`，需要 marching squares）。
- **地图明确不做**（用户已明确否决，体量与定位都不合适）；关系数据一律用力导向关系图表达。

## 坐标系与场景约定（多场景后新增，改动坐标系前必读）

- `norm.kind` 是场景判据：`cartesian` / `polar`（饼图）/ `radar` / `sankey`。
  新增图形类型时先确定它属于哪个场景，再决定布局分支（`computeLayout`）。
- **组件盒的坐标系故意不统一**：
  - 系列组件（含饼图 / 雷达）的盒 = 该场景的绘图区（极坐标是圆的外接正方形），
    本地坐标 = 图表坐标 − `plot.x/plot.y`；
  - 覆盖层与网格类组件（Axis / RadarGrid / Legend / Tooltip / DataZoomSlider）的盒 = 整块画布，
    本地坐标**就是**图表坐标，**不要**再减 `plot`。
  这条踩过坑：RadarGrid 多减了一次 `plot`，整张网格偏移到左上角。
  反过来也有坑：**比例尺 `scale.map()` 返回的是「绘图区本地坐标」（0..plot.width）**，
  覆盖层用它必须先加 `plot.x/plot.y` —— `PolarGrid` 忘了加，整张极坐标网格画到了绘图区外面
  （系列组件的盒就是绘图区，所以反而不用加）。
- **类目轴的缩放窗口必须切成类目区间**（数组 slice），不能赋成 `[起始类目, 结束类目]` 两个值 ——
  否则 N 个类目的轴会塌缩成 2 个类目（类目轴的柱子会突然变宽，就是它暴露的）。
- 屏幕坐标向下的轴（y 轴 range = `[height, 0]`）里画 band 类矩形时，
  band 是**从起点向上**延伸的：`y = bandStart - bandHeight`。热力图曾因此整块落到绘图区之外。
- 非直角坐标场景不画坐标轴，`computeLayout` 也不为它们预留空间（否则饼图圆会小一圈）。
- **直角坐标系列必须 `clipToBox = true`**：数值/时间轴缩放后，窗口外的点会被线性外推到画布之外，
  不裁剪就会盖住坐标轴与图例（用户实测反馈）。折线要的是「被绘图区边缘裁掉」，
  而不是「在边界处断开」，所以只能裁剪、不能过滤点。
- **类目轴的定位一律用类目值，不要用数据下标**：可见窗口是类目的子集，下标语义会错位
  （柱子/高亮会画到坐标轴上）。`BandScale.indexOf` 里也**不允许**再退回「把数值当类目下标」。
- 审计脚本的缩放步骤必须用**放大**（`deltaY < 0`）：满窗口时缩小是空操作，
  会让人误以为「缩放没问题」——这个盲区真实存在过。
- 「越界墨迹」探针**只查系列墨迹，不查图例**：图例色块本来就是饱和色、而且画在绘图区外面。
  等比坐标（`aspect: 'equal'`）会把绘图区缩成正方形并居中，左轴带随之变宽、正好罩住居中的图例 ——
  不排除图例带就会报假警（实测 296 像素）。左右轴带的扫描起点因此取「图例下沿」（图例在下方则扫到上沿为止）。
