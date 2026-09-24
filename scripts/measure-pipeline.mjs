/**
 * **更新流水线的成本尺子**（`plans/incremental-pipeline.md` 的证据来源）。
 *
 * 量的是「数据一变就重跑」那条流水线：归一化 + 布局 + 同步组件。
 * 它不随「数据怎么存」变化 —— 列存 / 环形把存储压到 O(1) 之后，
 * 这条流水线就是每 tick 的地板。
 *
 * 页面自己建图（不依赖任何示例页的配置），只需要页面里加载了 ice-chart 的 UMD：
 * ```
 * npm run build && npm run examples:prepare
 * node scripts/serve-examples.cjs &
 * node scripts/measure-pipeline.mjs                 # 默认打 5177 的示例页当宿主
 * node scripts/measure-pipeline.mjs --url http://127.0.0.1:8102/examples/streaming-candles.html
 * ```
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const URL = readArg('url', 'http://127.0.0.1:5177/examples/large-data-virtual-series.html');
const POINTS = Number(readArg('points', '10000'));
const TICKS = Number(readArg('ticks', '20'));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const cdp = await page.context().newCDPSession(page);
await cdp.send('HeapProfiler.enable');
page.on('pageerror', (error) => console.error('PAGEERROR', error.message));
await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(2000);

/**
 * `withWindow`：每 tick 追加之后顺手把**视窗**推到最新一段（真实看盘场景 ——
 * 轴只显示窗口里那一段类目）。这一档专门量「视窗裁剪之后类目轴还认不认增量查表」：
 * 不认的话 `BandScale` 会为整张 10 万条的类目表每帧重建一张索引 Map。
 */
const measure = async (virtual, withWindow = false) =>
  page.evaluate(
    async ({ POINTS, TICKS, virtual, withWindow }) => {
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;left:0;top:0;z-index:9;background:#fff';
      const canvas = document.createElement('canvas');
      canvas.width = 1100;
      canvas.height = 460;
      host.appendChild(canvas);
      document.body.appendChild(host);
      /**
       * 页内注册一个最小自定义系列（每点一根小竖条）。
       *
       * 为什么不用内置的 `line`：内置的数值列系列**只吃数值型 x**，
       * 而这条尺子要量的正是「自定义系列 + 类目轴」那条路（K 线就是它）——
       * 走的是惰性原始点存储，与数值列是两套。
       */
      if (!window.__probeRegistered) {
        class Probe extends window.ICEChart.SeriesBase {
          constructor(series, props) {
            super(series, props);
            this.seriesType = 'probe';
            this.clipToBox = true;
          }
          doRender() {
            this.rebuildPixels();
            const n = this.pixels.length / 2;
            if (!n) return;
            this.beginDraw();
            this.ctx.fillStyle = '#0D6EFD';
            const slot = Math.max(1, (this.state.width / n) * 0.6);
            for (let i = 0; i < n; i++) {
              const x = this.pixels[i * 2];
              const y = this.pixels[i * 2 + 1];
              if (!isFinite(x) || !isFinite(y)) continue;
              this.ctx.fillRect(x - slot / 2, y, slot, 6);
            }
            this.endDraw();
          }
          hitTestIndex(localX) {
            let best = -1;
            let bestDist = 6;
            for (let i = 0; i < this.series.pointCount; i++) {
              const pixel = this.pixelAt(i);
              if (!pixel) continue;
              const dist = Math.abs(pixel[0] - localX);
              if (dist <= bestDist) {
                bestDist = dist;
                best = i;
              }
            }
            return best;
          }
        }
        window.ICEChart.registerSeriesType('probe', (series, props) => new Probe(series, props));
        window.__probeRegistered = true;
      }
      // 类目轴 + 1 万个类目：与 K 线（时间轴逐根唯一）同一种轴压力
      const data = new Array(POINTS);
      for (let i = 0; i < POINTS; i++) data[i] = { x: `D${i}`, y: 50 + Math.sin(i / 37) * 20 };
      const chart = window.ICEChart.createChart(canvas, {
        legend: { show: false },
        animation: { enabled: false },
        xAxis: { type: 'category' },
        yAxis: {},
        series: [{ id: 's', type: 'probe', name: 'S', yField: 'y', data, virtual }],
      });
      await chart.render();
      window.__measured = chart;
      let applyMs = 0;
      const originalApply = chart.applyOption.bind(chart);
      chart.applyOption = (...rest) => {
        const t = performance.now();
        const out = originalApply(...rest);
        applyMs += performance.now() - t;
        return out;
      };
      const push = (i) => {
        const row = { x: `N${i}`, y: 50 + Math.sin(i / 37) * 20 };
        if (!virtual) {
          // 普通路：应用自己维护数组 + setData（K 线终端页就是这么喂的）
          windowRows.push(row);
          if (windowRows.length > POINTS) windowRows.shift();
          chart.setData('s', windowRows.slice());
        } else {
          chart.appendData('s', [row], { maxPoints: POINTS });
        }
        if (withWindow) chart.setDomainFromFractions(0.6, 1, 'api');
      };
      const windowRows = data.slice();
      const total = [];
      for (let i = 0; i < TICKS; i++) {
        const t = performance.now();
        push(i);
        total.push(performance.now() - t);
      }
      total.sort((a, b) => a - b);
      const median = total[Math.floor(total.length / 2)];
      chart.destroy();
      host.remove();
      return {
        模式: virtual ? (withWindow ? '惰性原始点 + 环形 + 视窗' : '惰性原始点 + 环形') : '普通（concat + 重建）',
        点数: POINTS,
        '每 tick p50 ms': Math.round(median * 100) / 100,
        '其中 applyOption（流水线）ms': Math.round((applyMs / TICKS) * 100) / 100,
      };
    },
    { POINTS, TICKS, virtual, withWindow }
  );

const rows = [await measure(false), await measure(true), await measure(true, true)];
await cdp.send('HeapProfiler.collectGarbage');
const usage = await cdp.send('Runtime.getHeapUsage');
console.log(JSON.stringify({ url: URL, 堆MB: Math.round((usage.usedSize / 1048576) * 10) / 10, rows }, null, 1));
await browser.close();
