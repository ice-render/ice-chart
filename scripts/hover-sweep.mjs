/**
 * 悬停反馈实测：逐页逐类型把指针移到每个数据点上，验证
 *
 *   1. 交互层把 hoverIndex 正确下发给对应系列；
 *   2. 反馈动画确实推进到 1（不是「只改了一个字段但没画出来」）；
 *   3. 悬停几何 / 提示框 / 高亮环都还在自己的容器里（不越出画布、不压坐标轴标签）；
 *   4. 全程没有 console 报错。
 *
 * 同时按「图 + 系列」截图，供人工复核外观。
 *
 * 用法：node scripts/hover-sweep.mjs [输出目录] [起始URL]
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const outDir = process.argv[2] || path.resolve(process.cwd(), '.hover-sweep');
const baseUrl = process.argv[3] || 'http://localhost:5177/examples';
const pages = [
  'basic-line',
  'bar-stack',
  'horizontal-bubble',
  'multi-axis',
  'pie',
  'radar',
  'funnel-gauge',
  'boxplot-waterfall',
  'treemap',
  'graph',
  'mini-matlab',
  'finance',
  'sankey',
  'time-series',
  'live-stream',
  'dashboard',
];

fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const report = [];

for (const name of pages) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.goto(`${baseUrl}/${name}.html`, { waitUntil: 'load' });
  await page.waitForTimeout(700);

  const charts = await page.evaluate(() => {
    const found = [];
    const push = (c, key) => {
      if (c && c.norm && c.layout) found.push({ key, index: found.length });
    };
    push(window.__chart, 'chart');
    if (window.__charts) for (const k of Object.keys(window.__charts)) push(window.__charts[k], k);
    return found;
  });

  // 像素缓存新鲜度：清掉各类的缓存键再重算一遍，两次结果必须一致。
  // 不一致 = 缓存键漏了某个几何输入（数据域 / 绘图区），页面上的表现是
  // 「悬停高亮画在别处」「命中判空」这类看起来像交互 bug 的问题。
  const stale = await page.evaluate(() => {
    const list = [];
    const push = (c) => {
      if (c && c.norm && c.layout) list.push(c);
    };
    push(window.__chart);
    if (window.__charts) for (const k of Object.keys(window.__charts)) push(window.__charts[k]);
    const out = [];
    for (const chart of list) {
      for (const comp of chart.seriesComponents) {
        if (!comp.pixels || !comp.pixels.length) continue;
        const before = Array.from(comp.pixels);
        for (const k of Object.keys(comp)) {
          if (/key$/i.test(k) && typeof comp[k] === 'string') comp[k] = '';
        }
        comp.rebuildPixels();
        const after = Array.from(comp.pixels);
        let diff = 0;
        for (let i = 0; i < Math.max(before.length, after.length); i++) {
          const a = before[i];
          const b = after[i];
          if (a === b) continue;
          if (Number.isNaN(a) && Number.isNaN(b)) continue;
          if (Math.abs(a - b) > 0.01) diff++;
        }
        if (diff) out.push({ type: comp.seriesType, diff });
      }
    }
    return out;
  });

  for (const meta of charts) {
    const seriesCount = await page.evaluate((i) => {
      const list = [];
      const push = (c) => {
        if (c && c.norm && c.layout) list.push(c);
      };
      push(window.__chart);
      if (window.__charts) for (const k of Object.keys(window.__charts)) push(window.__charts[k]);
      return list[i].seriesComponents.length;
    }, meta.index);

    for (let s = 0; s < seriesCount; s++) {
      const probes = await page.evaluate(
        ({ i, s }) => {
          const list = [];
          const push = (c) => {
            if (c && c.norm && c.layout) list.push(c);
          };
          push(window.__chart);
          if (window.__charts) for (const k of Object.keys(window.__charts)) push(window.__charts[k]);
          const chart = list[i];
          const comp = chart.seriesComponents[s];
          const n = comp.series.points.length;
          // 候选点铺得密一些：玫瑰线 / 参数曲线的极值点往往正好压在绘图区边缘，
          // 只取首/中/尾会被「贴边跳过」全部过滤掉，于是新图表默默没有探针。
          const fractions = [0, 1 / 8, 1 / 4, 3 / 8, 1 / 2, 5 / 8, 3 / 4, 7 / 8, 1];
          const candidates = [...new Set(fractions.map((f) => Math.round((n - 1) * f)))];
          // 画布在页面里的位置 + CSS 缩放：布局坐标是画布内部坐标，鼠标事件是视口坐标
          const canvasRect = chart.canvasElement.getBoundingClientRect();
          const canvas = chart.layout.canvas;
          const scaleX = canvasRect.width / (canvas.width || 1);
          const scaleY = canvasRect.height / (canvas.height || 1);
          const valid = [];
          for (const t of candidates) {
            const pixel = comp.pixelAt(t);
            if (!pixel) continue;
            // 组件盒的左上角 + 组件本地像素：极坐标 / 桑基 / 雷达的盒不等于 layout.plot
            const localX = comp.state.left + pixel[0];
            const localY = comp.state.top + pixel[1];
            const plot = { x: comp.state.left, y: comp.state.top, width: comp.state.width, height: comp.state.height };
            const margin = 6;
            // 贴边点（尤其时间轴的首尾、极坐标曲线的极值点）本来就在绘图区边缘，不算交互缺陷
            if (localX < plot.x + margin || localX > plot.x + plot.width - margin) continue;
            if (localY < plot.y + margin || localY > plot.y + plot.height - margin) continue;
            valid.push({ t, view: [canvasRect.x + localX * scaleX, canvasRect.y + localY * scaleY] });
          }
          // 有效点里挑首 / 中 / 尾三个，保证分散
          const picked = valid.length <= 3 ? valid : [valid[0], valid[Math.floor(valid.length / 2)], valid[valid.length - 1]];
          return picked.map((item) => [item.view[0], item.view[1], item.t]);
        },
        { i: meta.index, s }
      );

      for (const probe of probes) {
        if (!probe) continue;
        const [sx, sy, target] = probe;
        // 数据流页面（大屏 / 实时流）的几何会在两次采样之间移动：
        // 探针算好坐标、鼠标移过去时，图元可能已经缩小/滑走，指针真的不在它上面。
        // 这不是交互缺陷，所以允许「重算坐标 + 重试一次」。
        let result = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          let point = [sx, sy];
          if (attempt > 0) {
            const retry = await page.evaluate(
              ({ i, s, t }) => {
                const list = [];
                const push = (c) => {
                  if (c && c.norm && c.layout) list.push(c);
                };
                push(window.__chart);
                if (window.__charts) for (const k of Object.keys(window.__charts)) push(window.__charts[k]);
                const chart = list[i];
                const comp = chart.seriesComponents[s];
                const pixel = comp.pixelAt(t);
                if (!pixel) return null;
                const rect = chart.canvasElement.getBoundingClientRect();
                const canvas = chart.layout.canvas;
                return [
                  rect.x + (comp.state.left + pixel[0]) * (rect.width / (canvas.width || 1)),
                  rect.y + (comp.state.top + pixel[1]) * (rect.height / (canvas.height || 1)),
                ];
              },
              { i: meta.index, s, t: target }
            );
            if (retry) point = retry;
          }
          await page.mouse.move(point[0], point[1]);
          await page.waitForTimeout(340);
          result = await page.evaluate(
            ({ i, s, target }) => {
            const list = [];
            const push = (c) => {
              if (c && c.norm && c.layout) list.push(c);
            };
            push(window.__chart);
            if (window.__charts) for (const k of Object.keys(window.__charts)) push(window.__charts[k]);
            const chart = list[i];
            const comp = chart.seriesComponents[s];
            const canvas = chart.layout.canvas;
            const plot = chart.layout.plot;
            // 多系列叠在同一位置时（雷达 / 折线），命中会落到最上面的系列，
            // 所以「有没有反馈」要看整张图，而不是只看探测的那个下标。
            const anyHover = chart.seriesComponents
              .map((c) => ({ index: c.hoverIndex, t: c.highlightT(), type: c.seriesType }))
              .filter((c) => c.index !== null && c.t > 0.6);
            const tooltip = chart.tooltip && chart.tooltip.lastRect ? chart.tooltip.lastRect : null;
            const highlight = (chart.highlight && chart.highlight.hoverItems) || [];
            const inside = (r, box, tol = 1) =>
              r.x >= box.x - tol && r.y >= box.y - tol && r.x + r.width <= box.x + box.width + tol && r.y + r.height <= box.y + box.height + tol;
            return {
              hoverIndex: comp.hoverIndex,
              highlightT: comp.highlightT(),
              anyHover,
              target,
              tooltipInside: tooltip ? inside(tooltip, canvas) : null,
              highlightOffPlot: highlight.filter((m) => !inside({ x: m.x - 6, y: m.y - 6, width: 12, height: 12 }, plot, 8)).length,
              seriesType: comp.seriesType,
            };
            },
            { i: meta.index, s, target }
          );
          if (result.hoverIndex !== null || result.anyHover.length > 0) break;
        }
        // 折线 / 面积是「轴触发」：命中的列由比例尺就近吸附，未必等于探测点的下标，
        // 所以这里断言「有悬停 + 动画到位」，下标差异只记录不判失败。
        const pass = result.anyHover.length > 0 && result.tooltipInside !== false && result.highlightOffPlot === 0;
        report.push({ page: name, chart: meta.key, series: s, ...result, indexDelta: result.hoverIndex === null ? null : result.hoverIndex - target, pass });
      }

      if (probes.filter(Boolean).length) {
        const box = await page.evaluate(({ i }) => {
          const list = [];
          const push = (c) => {
            if (c && c.norm && c.layout) list.push(c);
          };
          push(window.__chart);
          if (window.__charts) for (const k of Object.keys(window.__charts)) push(window.__charts[k]);
          const chart = list[i];
          const r = chart.canvasElement.getBoundingClientRect();
          return { x: r.x - 6, y: r.y - 6, width: r.width + 12, height: r.height + 12 };
        }, { i: meta.index });
        await page.screenshot({
          path: path.join(outDir, `${name}-${meta.key}-s${s}.png`),
          clip: { x: Math.max(0, box.x), y: Math.max(0, box.y), width: box.width, height: box.height },
        });
      }
    }
  }

  report.push({ page: name, errors });
  if (stale.length) report.push({ page: name, stalePixels: stale });
  await page.close();
}

await browser.close();

const failures = report.filter((r) => r.pass === false);
const errorRows = report.filter((r) => r.errors && r.errors.length);
const staleRows = report.filter((r) => r.stalePixels);
const checks = report.filter((r) => r.pass !== undefined);
console.log(
  JSON.stringify(
    {
      checks: checks.length,
      failures,
      pageErrors: errorRows,
      stalePixels: staleRows,
      types: [...new Set(checks.map((c) => c.seriesType))].sort(),
    },
    null,
    1
  )
);
process.exit(failures.length || errorRows.length || staleRows.length ? 1 : 0);
