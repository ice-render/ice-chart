/**
 * 交互外观审计：对每个示例页跑一遍真实交互（悬停 / 缩放 / 平移 / 框选 / 图例 / 键盘 / 滑块），
 * 每步都做两件事：
 *   1. 截图（人工复核外观有没有异常、交叠）；
 *   2. 页内几何断言（提示框是否越界、是否压住坐标轴标签/图例，高亮是否落在绘图区内）。
 *
 * 用法：
 *   npm run build && npm run examples:prepare
 *   node scripts/serve-examples.cjs &
 *   node scripts/audit-interactions.mjs [输出目录] [起始URL]
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const outDir = process.argv[2] || path.resolve(process.cwd(), '.audit');
const baseUrl = process.argv[3] || 'http://localhost:5177/examples';
/**
 * 已知问题（显式登记，避免「把页面从门禁里删掉」这种掩盖）。
 *
 * **2026-09-23 起清空** —— 之前唯一的条目 `editable-chart` 已经查明并解决，机制留着备用。
 *
 * 那个 112px 的完整故事（值得留着，因为中间错了四次）：
 * 拖动平移之后，editable-chart 左右轴带各有 ~112 个饱和像素。逐条排除：
 *   ① **不是旧帧残留** —— 强制整屏重画（`markQueueDirty()` + `markViewportChanged()`）不变；
 *   ② **不是直角坐标系列** —— 统一打开 `clipToBox` 后纹丝不动；
 *   ③ **不是 `addMark` 的标记层** —— 把它改成绘图区大小 + `clipChildren` 也纹丝不动
 *      （顺带证明：那次改动改变了「图元 left/top 是画布坐标」这条既有约定、还改了两个用例，
 *      却解决不了问题 —— 已撤销）；
 *   ④ **不是 `annotation` 组件** —— 示例页根本没写 `option.annotation`。
 *   ✅ 最后靠**画面比对 + 引擎自己的 `hitTest`** 定的案：那是个**蓝底红边的小方块 = 可拖图元的
 *      变换手柄**（`ResizeControl`，父级 `TransformControlPanel`）。它是**交互外壳，不是数据墨迹**。
 *
 * 所以修的是**探针**：把手柄的盒子从统计里扣掉（见 `paintOverflowProbe` 里的 `chrome`）。
 * 关键坑：`TransformControlPanel` 是**全局单例、直接画在 canvas 上、不是任何组件的孩子**
 * （见 `ICEControlPanelManager`），所以只走 `ice.childNodes` 永远找不到它 ——
 * 必须从 `ice.controlPanelManager` 拿。
 *
 * 复现手段：`PAGES=editable-chart INK=1 node scripts/audit-interactions.mjs`
 * （INK=1 会把每一步每张图的墨迹量打出来，豁免也拦不住它 —— 排查时就靠这个）。
 */
const KNOWN_ISSUES = {};

const pages = [
  'basic-line',
  'bar-stack',
  'horizontal-bubble',
  'multi-axis',
  'pie',
  'radar',
  'funnel-gauge',
  'boxplot-waterfall',
  'distribution',
  'matrix',
  'hexbin',
  'joint-plot',
  'calendar',
  'alluvial',
  'treemap',
  'graph',
  'mini-matlab',
  'dsl-vs-option',
  'editable-chart',
  'annotation',
  'animation',
  'sankey',
  'serialize',
  'interactions',
  'time-series',
  'live-stream',
  'dashboard',
  'dashboard-iot',
  'dashboard-energy',
  'dashboard-logistics',
  'dashboard-lab',
  'large-data',
  'large-data-virtual-series',
  'a11y',
  'linked-charts',
];

fs.mkdirSync(outDir, { recursive: true });

/**
 * 只跑指定的页（逗号分隔）—— 排障用：整轮 322 步要几分钟，盯一页时没必要全跑。
 *   PAGES=dashboard,dashboard-logistics node scripts/audit-interactions.mjs
 * `INK=1` 再逐步打印每张图的墨迹量（哪一步、哪张图、左右下各多少），用来定位残留。
 */
const onlyPages = process.env.PAGES ? process.env.PAGES.split(',').map((s) => s.trim()) : null;
const dumpInk = process.env.INK === '1';
/** 每步动作之后等多久再采样（默认 220ms）。排障用：动画没停就采样会采到过渡中的一帧。 */
const stepWait = Number(process.env.STEP_WAIT || 220);
const runPages = onlyPages ? pages.filter((name) => onlyPages.includes(name)) : pages;
if (onlyPages && !runPages.length) {
  console.error(`PAGES 里没有任何已知页面：${process.env.PAGES}`);
  process.exit(2);
}

/** 注入到页面里：收集每张图的几何信息，用于「有没有交叠/越界」的自动判断。 */
function collectGeometry() {
  const charts = [];
  const push = (c) => {
    if (c && c.norm && c.layout) charts.push(c);
  };
  push(window.__chart);
  const many = window.__charts;
  if (many && typeof many === 'object') for (const key of Object.keys(many)) push(many[key]);
  const link = window.__link;
  if (link && Array.isArray(link.charts)) for (const c of link.charts) push(c);
  return charts.map((c) => {
    const canvas = c.layout.canvas;
    const plot = c.layout.plot;
    const legendItems = (c.layout.legend ? c.layout.legend.items : []).map(it => ({
      x: it.x,
      y: it.y,
      width: it.width,
      height: it.height,
    }));
    const tooltip = c.tooltip && c.tooltip.lastRect ? c.tooltip.lastRect : null;
    const chips = c.crosshair && c.crosshair.lastChipRects ? c.crosshair.lastChipRects : [];
    // 高亮标记的 x/y 一律是中心；贴边的数据点允许半个标记探出绘图区
    const marks =
      c.highlight && c.highlight.hoverItems
        ? c.highlight.hoverItems.map((m) => ({
            // 标记的 x/y 是中心；圆形用 size，柱形用 width/height
            x: m.shape === 'rect' ? m.x - (m.width || 0) / 2 : m.x - (m.size || 0) / 2,
            y: m.shape === 'rect' ? m.y - (m.height || 0) / 2 : m.y - (m.size || 0) / 2,
            width: m.shape === 'rect' ? m.width || 0 : m.size || 0,
            height: m.shape === 'rect' ? m.height || 0 : m.size || 0,
            slack: m.shape === 'rect' ? 2 : (m.size || 0) / 2 + 1,
          }))
        : [];
    return { canvas, plot, legendItems, tooltip, chips, marks, kind: c.norm.kind, slider: c.layout.slider };
  });
}

function overlaps(a, b) {
  return !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
}

function inside(inner, outer, tol = 0.5) {
  return (
    inner.x >= outer.x - tol &&
    inner.y >= outer.y - tol &&
    inner.x + inner.width <= outer.x + outer.width + tol &&
    inner.y + inner.height <= outer.y + outer.height + tol
  );
}

/**
 * 统计「越出绘图区的彩色墨迹」。
 *
 * 只数饱和色（各通道极差 > 45）：坐标轴/文字是灰阶，不算；图例色块在上方、dataZoom 滑块在下方，
 * 用「只查左右两条轴标签带 + 坐标轴标签带」把它们排除掉。
 * 返回 > 0 说明有系列把墨迹画到了坐标轴上（缩放后窗口外的点最容易这样）。
 */
function paintOverflowProbe() {
  const charts = [];
  if (window.__chart) charts.push(window.__chart);
  const many = window.__charts;
  if (many) for (const k of Object.keys(many)) charts.push(many[k]);
  const link = window.__link;
  if (link && link.charts) charts.push(...link.charts);
  return charts
    .filter((c) => c && c.ice && c.norm && c.norm.kind === 'cartesian' && c.ice.canvasEl)
    .map((c) => {
      const cv = c.ice.canvasEl;
      const ctx = cv.getContext('2d');
      const dpr = c.ice.dpr || 1;
      /**
       * **交互手柄不算数据墨迹**（2026-09-23）。
       *
       * `editable-chart` 那条 112px 排查了很久，最后靠引擎的 `hitTest` 定位到：
       * 那个蓝底红边的小方块是**可拖图元的变换手柄**（`ResizeControl`，父级
       * `TransformControlPanel`），画在图元边界上、半个落在轴带里 —— 它是**交互外壳**，
       * 不是数据画到了坐标轴上。探针的立意是「数据墨迹不许进轴带」，所以这里把手柄的盒子
       * 扣掉（和上面扣图例带同一个道理）。
       *
       * 用引擎自己的 `__paintWorldBox()` 拿画布坐标（它本来就用这套做裁剪）。
       *
       * ⚠️ 面板**不是组件的孩子**：`TransformControlPanel` 是全局单例、直接画在 canvas 上
       * （见 `ICEControlPanelManager`），所以只走 `ice.childNodes` 永远找不到它 ——
       * 必须从 `ice.controlPanelManager` 拿。
       */
      const chrome = [];
      const collectChrome = (node) => {
        if (!node) return;
        const name = (node.constructor && node.constructor.name) || '';
        if (/Control|Handle/.test(name) && node.state && node.state.display !== false && typeof node.__paintWorldBox === 'function') {
          const b = node.__paintWorldBox();
          if (b && b.every((v) => isFinite(v))) chrome.push([b[0] * dpr - 2, b[1] * dpr - 2, b[2] * dpr + 2, b[3] * dpr + 2]);
        }
        const kids = node.childNodes;
        if (Array.isArray(kids)) for (const k of kids) collectChrome(k);
      };
      if (Array.isArray(c.ice.childNodes)) for (const node of c.ice.childNodes) collectChrome(node);
      const panelManager = c.ice.controlPanelManager;
      if (panelManager) {
        if (panelManager.transformControlPanel) collectChrome(panelManager.transformControlPanel);
        if (panelManager.lineControlPanel) collectChrome(panelManager.lineControlPanel);
      }
      const inChrome = (x, y) =>
        chrome.some((b) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]);
      const plot = c.layout.plot;
      const slider = c.layout.slider;
      const W = cv.width / dpr;
      const H = cv.height / dpr;
      const scan = (x0, y0, w, h) => {
        const X = Math.round(x0 * dpr);
        const Y = Math.round(y0 * dpr);
        const PW = Math.round(w * dpr);
        const PH = Math.round(h * dpr);
        if (PW <= 0 || PH <= 0 || X < 0 || Y < 0 || X + PW > cv.width || Y + PH > cv.height) return 0;
        const data = ctx.getImageData(X, Y, PW, PH).data;
        let n = 0;
          // 逐像素走（要按坐标跳过手柄盒子），不再用一维步进
          for (let row = 0; row < PH; row++) {
            for (let col = 0; col < PW; col++) {
              const i = (row * PW + col) * 4;
              const a = data[i + 3];
              if (a < 60) continue;
              const r = data[i];
              const g = data[i + 1];
              const b = data[i + 2];
              if (Math.max(r, g, b) - Math.min(r, g, b) <= 45) continue;
              if (inChrome(X + col, Y + row)) continue;
              n++;
            }
          }
          return n;
      };
      // 图例带不算「越界墨迹」：图例色块本来就是饱和色，而且它画在绘图区外面。
      // 等比坐标（aspect: 'equal'）会把绘图区缩成正方形并居中，左轴带随之变宽 ——
      // 这时居中的图例就落在左轴带里，不改的话会被误判成「图形画到了坐标轴上」。
      const legendItems = (c.layout.legend ? c.layout.legend.items : []) || [];
      const legendTop = legendItems.length ? Math.min(...legendItems.map((it) => it.y)) : Infinity;
      const legendBottom = legendItems.length ? Math.max(...legendItems.map((it) => it.y + it.height)) + 3 : 0;
      const axisBandBottom = slider ? slider.y - 3 : H;
      /**
       * y 方向的竖直滑块（`dataZoom.sliderY`）也是**交互外壳**，不是数据墨迹 ——
       * 它就画在绘图区右侧（与「右轴带」重合），蓝底窗口会被误判成「图形画到了坐标轴上」。
       * 所以右轴带只扫到滑块左沿为止（与下面扣掉 x 滑块那条轨道同一个道理）。
       */
      const sliderYRect = c.layout.sliderY;
      const rightScanX = plot.x + plot.width + 3;
      const rightScanW = sliderYRect ? Math.max(0, sliderYRect.x - 2 - rightScanX) : W - rightScanX;
      // 图例在绘图区上方：左右轴带从图例下沿开始扫；图例在下方：y 轴带扫到图例上沿为止
      const sideTop = legendItems.length && legendTop < plot.y ? legendBottom : 0;
      const belowEnd = legendItems.length && legendTop > plot.y + plot.height ? Math.min(axisBandBottom, legendTop - 3) : axisBandBottom;
      return {
        left: scan(0, sideTop, plot.x - 3, H - sideTop),
        right: scan(rightScanX, sideTop, rightScanW, H - sideTop),
        below: scan(0, plot.y + plot.height + 3, W, belowEnd - plot.y - plot.height - 3),
      };
    });
}

const browser = await chromium.launch();
const report = [];

for (const name of runPages) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  await page.goto(`${baseUrl}/${name}.html`, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  /** 一次「交互 + 断言 + 截图」。 */
  const step = async (label, action, extra) => {
    if (action) await action();
    await page.waitForTimeout(stepWait);
    const geometry = await page.evaluate(collectGeometry);
    const overflow = await page.evaluate(paintOverflowProbe);
    const issues = [];
    const known = KNOWN_ISSUES[name] || [];
    const pushIssue = (issue) => {
      if (known.some((prefix) => issue.startsWith(prefix))) return; // 已登记，记进报告但不判失败
      issues.push(issue);
    };
    for (const o of overflow) {
      if (o.left > 40) pushIssue(`ink-over-y-axis(${o.left})`);
      if (o.right > 40) pushIssue(`ink-over-right-axis(${o.right})`);
      if (o.below > 40) pushIssue(`ink-over-x-axis(${o.below})`);
    }
    if (dumpInk) {
      overflow.forEach((o, index) => {
        if (o.left > 0 || o.right > 0 || o.below > 0) {
          console.log(`  [ink] ${name} ${label} 图${index}: 左${o.left} 右${o.right} 下${o.below}`);
        }
      });
    }
    for (const g of geometry) {
      if (g.tooltip) {
        if (!inside(g.tooltip, g.canvas)) issues.push('tooltip-out-of-canvas');
        for (const chip of g.chips) if (overlaps(g.tooltip, chip)) issues.push('tooltip-over-axis-label');
        for (const item of g.legendItems) if (overlaps(g.tooltip, item)) issues.push('tooltip-over-legend');
      }
      for (const mark of g.marks) {
        // 圆环允许贴边（半个标记可探出）；柱形高亮必须整块在绘图区内
        if (!inside(mark, g.plot, mark.slack)) issues.push('highlight-out-of-plot');
      }
    }
    if (extra) {
      for (const item of await extra()) issues.push(item);
    }
    await page.screenshot({ path: path.join(outDir, `${name}-${label}.png`) });
    report.push({ page: name, step: label, charts: geometry.length, issues });
  };

  const firstCanvas = await page.$('canvas');
  const box = firstCanvas ? await firstCanvas.boundingBox() : null;
  const target = async (fx, fy) => {
    if (!box) return [10, 10];
    return [box.x + box.width * fx, box.y + box.height * fy];
  };

  await step('01-baseline');
  await step('02-hover-mid', async () => {
    const [x, y] = await target(0.45, 0.45);
    await page.mouse.move(x, y, { steps: 4 });
  });
  await step('03-hover-bottom', async () => {
    const [x, y] = await target(0.2, 0.82);
    await page.mouse.move(x, y, { steps: 4 });
  });
  await step('04-hover-edge', async () => {
    const [x, y] = await target(0.97, 0.3);
    await page.mouse.move(x, y, { steps: 4 });
  });
  await step('05-wheel-zoom', async () => {
    const [x, y] = await target(0.5, 0.5);
    await page.mouse.move(x, y);
    // 注意：必须是「放大」（deltaY < 0）。之前在满窗口时用放大缩小是空操作，
    // 于是漏掉了「缩放后窗口外的点被画到坐标轴上」这个真实缺陷。
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, -240);
      await page.waitForTimeout(80);
    }
  });
  await step('06-drag-pan', async () => {
    const [x, y] = await target(0.5, 0.5);
    await page.mouse.move(x, y);
    await page.mouse.down();
    const [x2, y2] = await target(0.3, 0.5);
    await page.mouse.move(x2, y2, { steps: 8 });
    await page.mouse.up();
  });
  await step('07-brush', async () => {
    const [x, y] = await target(0.25, 0.35);
    const [x2, y2] = await target(0.6, 0.7);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x2, y2, { steps: 10 });
    await page.mouse.up();
  });
  await step('08-keyboard', async () => {
    const [x, y] = await target(0.4, 0.5);
    await page.mouse.click(x, y);
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(60);
    }
  });
  await step('09-legend-toggle', async () => {
    await page.evaluate(() => {
      const charts = [];
      if (window.__chart) charts.push(window.__chart);
      const many = window.__charts;
      if (many) for (const k of Object.keys(many)) charts.push(many[k]);
      const link = window.__link;
      if (link && link.charts) charts.push(...link.charts);
      const chart = charts.find((c) => c && c.layout && c.layout.legend && c.layout.legend.items.length);
      if (chart) {
        const item = chart.layout.legend.items[0];
        chart.controller.handleClick(item.x + item.width / 2, item.y + item.height / 2);
      }
    });
  });
  await step('10-after-toggle-hover', async () => {
    const [x, y] = await target(0.5, 0.5);
    await page.mouse.move(x, y, { steps: 3 });
  });

  // 11. dataZoom 滑块拖到极限：窗口不能塌缩成「一个点」或「什么都没画」。
  //     实测过：time-series 拖到最右时窗口落进取整出来的空白区 → 可视点 0 个、整条曲线消失。
  const slider = await page.evaluate(() => {
    const charts = [];
    if (window.__chart) charts.push(window.__chart);
    if (window.__charts) for (const k of Object.keys(window.__charts)) charts.push(window.__charts[k]);
    const chart = charts.find((c) => c && c.layout && c.layout.slider);
    if (!chart) return null;
    window.__sliderChart = chart;
    const rect = chart.ice.canvasEl.getBoundingClientRect();
    const s = chart.layout.slider;
    const dpr = chart.ice.dpr || 1;
    const [f0, f1] = chart.domainFractions();
    const toView = (fx) => rect.left + (s.x + s.width * fx) / dpr;
    return { endX: toView(f1), startX: toView(f0), y: rect.top + (s.y + s.height / 2) / dpr, trackStart: toView(0.02) };
  });
  if (slider) {
    await step(
      '11-slider-extreme',
      async () => {
        await page.mouse.move(slider.endX, slider.y);
        await page.mouse.down();
        await page.mouse.move(slider.trackStart, slider.y, { steps: 14 });
        await page.mouse.up();
        await page.waitForTimeout(300);
      },
      async () =>
        page.evaluate(() => {
          const chart = window.__sliderChart;
          const issues = [];
          const dom = chart.norm.xAxis.domain;
          const numeric = typeof dom[0] === 'number';
          const lo = numeric ? dom[0] : 0;
          const hi = numeric ? dom[dom.length - 1] : dom.length - 1;
          for (const comp of chart.seriesComponents) {
            if (comp.state.display === false) continue;
            const total = comp.series.points.length;
            if (!total) continue;
            const visible = comp.series.points.filter((p, i) => {
              if (!numeric) return true;
              const v = Number(p.xValue);
              return isFinite(v) ? v >= lo && v <= hi : true;
            }).length;
            const need = total >= 3 ? 2 : 1;
            if (visible < need) issues.push(`slider-window-collapsed(${comp.series.name}:${visible}/${total})`);
          }
          return issues;
        })
    );
  }

  // 11b. 竖直滑块（y 窗口）拖到极限：同样不许把窗口拖成「一个点」或拖空。
  //      方向约定：上 = 大值，所以「往下拖」= 朝小值走。
  const sliderY = await page.evaluate(() => {
    const charts = [];
    if (window.__chart) charts.push(window.__chart);
    if (window.__charts) for (const k of Object.keys(window.__charts)) charts.push(window.__charts[k]);
    const chart = charts.find((c) => c && c.layout && c.layout.sliderY);
    if (!chart) return null;
    window.__sliderYChart = chart;
    const rect = chart.ice.canvasEl.getBoundingClientRect();
    const s = chart.layout.sliderY;
    const dpr = chart.ice.dpr || 1;
    const [f0, f1] = chart.domainYFractions();
    const toView = (fy) => rect.top + (s.y + s.height * (1 - fy)) / dpr;
    return {
      endY: toView(f1),
      startY: toView(f0),
      x: rect.left + (s.x + s.width / 2) / dpr,
      trackEnd: toView(0.02),
      fractions: [f0, f1],
    };
  });
  if (sliderY) {
    await step(
      '11b-sliderY-extreme',
      async () => {
        // 抓住窗口上端（大值那一侧）往下拖到接近轨道底部。
        // ⚠️ `page.mouse.move(x, y)` —— 竖直滑块的 x 是常量、动的是 y，写反了就会静默地什么都没拖到。
        await page.mouse.move(sliderY.x, sliderY.endY);
        await page.mouse.down();
        await page.mouse.move(sliderY.x, sliderY.trackEnd, { steps: 14 });
        await page.mouse.up();
        await page.waitForTimeout(300);
      },
      async () =>
        page.evaluate(({ fractions }) => {
          const chart = window.__sliderYChart;
          const issues = [];
          const dom = chart.norm.yAxis.domain.map(Number);
          const lo = Math.min(dom[0], dom[dom.length - 1]);
          const hi = Math.max(dom[0], dom[dom.length - 1]);
          if (!isFinite(lo) || !isFinite(hi) || hi - lo <= 0) {
            issues.push(`sliderY-window-collapsed(${dom.join('~')})`);
          }
          const [start, end] = chart.domainYFractions();
          if (!(end > start)) issues.push(`sliderY-window-empty(${start}~${end})`);
          /**
           * ⚠️ 这里**不**照抄 x 滑块那条「至少盖住 2 个数据点」的判据：y 窗口是**值域**，
           * 把量程外的系列排除在外正是它的语义（滚轮缩 y 也一样），不是塌缩。
           * y 该管的是「窗口没退化成一条线」—— 兜底在 `clampAxisDomain`（最小跨度 0.1%）
           * 与拖动时的 0.02 下限里。
           */
          if (end - start < 0.01) issues.push(`sliderY-window-degenerate(${start}~${end})`);
          // 探针不能只断言「没坏」：鼠标坐标写错时上面的检查全会通过，
          // 而窗口其实一步都没动（本轮真实踩过一次）。要求窗口**真的变了**。
          if (Math.abs(start - fractions[0]) < 1e-3 && Math.abs(end - fractions[1]) < 1e-3) {
            issues.push(`sliderY-drag-had-no-effect(${start}~${end})`);
          }
          return issues;
        }, sliderY)
    );
  }

  // 序列化 JSON 面板：必须存在、内容是可解析的真实快照、且带版本号
  const panel = await page.evaluate(() => {
    const api = window.__snapshotPanel;
    if (!api) return { present: false };
    let parsed = null;
    try {
      parsed = JSON.parse(api.full);
    } catch (err) {
      return { present: true, parseError: String(err && err.message) };
    }
    return {
      present: true,
      hasVersion: parsed && parsed.version !== undefined,
      hasOption: !!(parsed && parsed.option),
      series: parsed && parsed.option && parsed.option.series ? parsed.option.series.length : 0,
      bytes: api.full.length,
    };
  });
  const panelIssues = [];
  if (!panel.present) panelIssues.push('snapshot-panel-missing');
  else if (panel.parseError) panelIssues.push('snapshot-json-unparsable');
  else {
    if (!panel.hasVersion) panelIssues.push('snapshot-without-version');
    if (!panel.hasOption) panelIssues.push('snapshot-without-option');
  }
  report.push({ page: name, panel, issues: panelIssues, consoleErrors: errors });

  await page.close();
}

await browser.close();

const problems = report.filter((r) => (r.issues && r.issues.length) || (r.consoleErrors && r.consoleErrors.length));
console.log(JSON.stringify({ steps: report.length, problems }, null, 2));
console.log(`screenshots: ${outDir}`);
process.exit(problems.length ? 1 : 0);
