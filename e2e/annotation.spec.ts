/**
 * 标注（annotation）的**真浏览器**回归。
 *
 * 单测用的是 Canvas 2D 桩，只能验几何与诊断；这里要验的是桩验不了的东西：
 *  1) 真的光栅化出来了（有墨迹、没有 console 报错）；
 *  2) 墨迹落在它自己声明的盒里（不会因为脏矩形 / 离屏缓存被切掉半截）；
 *  3) **除标注覆盖的区域外，与「同一张图但不带标注」逐像素一致** ——
 *     这条是设计稿里的硬验收，能挡住「画标注时把坐标系 / 系列 / 坐标轴顺手改坏」；
 *  4) 标注不吃命中（压在数据点上时点的还是数据）；
 *  5) 越界的标注不画，但诊断里有明确原因。
 *
 * 逐像素比对刻意**在页面里做**（`window.__annotationDemo.compare()`）：浏览器里才有真实
 * 光栅化，而且只把统计结果（差异像素数、越界样本）传回来，不必把 160 万个像素搬过 CDP。
 */
import { test, expect } from '@playwright/test';

test.describe('标注（annotation）', () => {
  test('目标线 / 阈值线 / 异常点 / 达标区：画出墨迹、落在自己的盒里、不吃命中', async ({ page }) => {
    const errs: string[] = [];
    page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`.slice(0, 300)));
    page.on('console', (m) => {
      if (m.type() === 'error') errs.push(`console: ${m.text()}`.slice(0, 300));
    });

    await page.goto('/examples/annotation.html', { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const chart: any = (window as any).__chart;
      return !!chart && !!chart.annotation;
    });
    await page.evaluate(() => (window as any).__chart.finishAnimations());

    const state = await page.evaluate(() => {
      const chart: any = (window as any).__chart;
      const plot = chart.layout.plot;
      const canvas = chart.ice.canvasEl;
      return {
        lines: chart.annotation.resolved.lines.map((line: any) => ({
          axis: line.axis,
          pixel: line.pixel,
          text: line.text,
          dashed: line.lineDash.length > 0,
        })),
        points: chart.annotation.resolved.points.length,
        areas: chart.annotation.resolved.areas.length,
        diagnostics: chart.annotationDiagnostics().length,
        ink: chart.annotation.ink,
        plot,
        canvas: { width: canvas.width, height: canvas.height },
      };
    });

    expect(errs).toEqual([]);
    // 一条目标线 + 一条阈值线，都画成了虚线
    expect(state.lines).toHaveLength(2);
    expect(state.lines.every((line: any) => line.dashed)).toBe(true);
    expect(state.points).toBe(1);
    expect(state.areas).toBe(1);
    expect(state.diagnostics).toBe(0);

    // 横向标注线的定位像素必须落在绘图区内
    for (const line of state.lines) {
      expect(line.pixel).toBeGreaterThanOrEqual(state.plot.y);
      expect(line.pixel).toBeLessThanOrEqual(state.plot.y + state.plot.height);
    }
    // 每一处墨迹都不许越出画布（越出去就会被脏矩形切掉半截）
    for (const box of state.ink) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(state.canvas.width);
      expect(box.y + box.height).toBeLessThanOrEqual(state.canvas.height);
    }

    // 标注不吃命中：目标线上的中点在绘图区里，但点到的不是标注层
    const hit = await page.evaluate(() => {
      const chart: any = (window as any).__chart;
      const line = chart.annotation.resolved.lines[0];
      const plot = chart.layout.plot;
      return chart.ice.hitTest(plot.x + plot.width / 2, line.pixel) === chart.annotation;
    });
    expect(hit).toBe(false);
  });

  test('像素判据：除标注覆盖区域外，与不带标注的同一张图逐像素一致', async ({ page }) => {
    await page.goto('/examples/annotation.html', { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window as any).__annotationDemo);
    await page.evaluate(() => (window as any).__chart.finishAnimations());

    const result = await page.evaluate(() => (window as any).__annotationDemo.compare());

    // 有差异 —— 说明标注真的画上去了（不然这条测试会「因为什么都没画」而假通过）
    expect(result.diff).toBeGreaterThan(500);
    expect(result.ink.length).toBeGreaterThan(0);
    // 且差异**全部**落在标注自己的墨迹盒里（±3px 的描边余量）
    expect(result.samples).toEqual([]);
    expect(result.outside).toBe(0);
  });

  test('越界的值不画，但诊断说清楚原因（表单据此标红 / 提示）', async ({ page }) => {
    await page.goto('/examples/annotation.html', { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window as any).__chart);

    const before = await page.evaluate(() => (window as any).__chart.annotation.resolved.lines.length);
    await page.click('#toggle-bad');
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({
      lines: (window as any).__chart.annotation.resolved.lines.length,
      diagnostics: (window as any).__chart.annotationDiagnostics(),
    }));

    expect(after.lines).toBe(before);
    expect(after.diagnostics).toHaveLength(1);
    expect(after.diagnostics[0].code).toBe('annotation:out-of-range');
    expect(after.diagnostics[0].severity).toBe('warning');
  });

  test('缩放把标注推出窗口后自行消失，缩回来又出现', async ({ page }) => {
    await page.goto('/examples/annotation.html', { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window as any).__chart);
    await page.evaluate(() => (window as any).__chart.finishAnimations());
    const before = await page.evaluate(() => (window as any).__chart.annotation.resolved.lines.length);

    await page.evaluate(() => (window as any).__chart.setDomain('y', [0, 1000], 'api'));
    await page.waitForTimeout(200);
    const zoomed = await page.evaluate(() => ({
      lines: (window as any).__chart.annotation.resolved.lines.length,
      codes: (window as any).__chart.annotationDiagnostics().map((d: any) => d.code),
    }));
    expect(zoomed.lines).toBe(0);
    expect(zoomed.codes.every((code: string) => code === 'annotation:out-of-range')).toBe(true);

    await page.evaluate(() => (window as any).__chart.setDomain('y', [0, 3600], 'api'));
    await page.waitForTimeout(200);
    const restored = await page.evaluate(() => (window as any).__chart.annotation.resolved.lines.length);
    expect(restored).toBe(before);
  });

  test('存盘 → 载入 → 再出图：标注进快照，且还原后逐像素一致', async ({ page }) => {
    await page.goto('/examples/annotation.html', { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window as any).__annotationDemo);

    const result = await page.evaluate(() => (window as any).__annotationDemo.roundTrip());

    expect(result.hasAnnotation).toBe(true);
    expect(result.idempotent).toBe(true);
    expect(result.lines).toBe(2);
    expect(result.points).toBe(1);
    expect(result.areas).toBe(1);
    // 单测验的是「几何一致」，这里验的是「光栅化之后也一致」
    expect(result.diff).toBe(0);
  });

  test('布局变化（y 轴标签变窄 → plot.x 挪动）后不留旧位置的残墨', async ({ page }) => {
    await page.goto('/examples/annotation.html', { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window as any).__chart);

    // 全程在页面里跑：只有统计结果过 CDP，160 万个像素不搬来搬去
    const result = await page.evaluate(async () => {
      const chart: any = (window as any).__chart;
      const canvas = chart.ice.canvasEl;
      const ctx = canvas.getContext('2d');
      const grab = () => ctx.getImageData(0, 0, canvas.width, canvas.height);
      const settle = async () => {
        chart.finishAnimations();
        await chart.render();
        chart.finishAnimations();
        await chart.render();
      };

      const base = chart.getOption();
      const line = { axis: 'y', value: 30, text: '低水位线', color: '#dc3545' };

      // 布局 L1：y 轴 [0,3600]，刻度标签 "4,000" 宽 → plot.x 大
      const yAxisWide = { min: 0, max: 3600, name: '单量' };
      chart.setOption(
        { ...base, yAxis: yAxisWide, annotation: { lines: [line] } },
        { animate: false, preserveView: false }
      );
      await settle();
      const plotX1 = chart.layout.plot.x;
      const oldPixel = chart.annotation.resolved.lines[0].pixel;

      // 布局 L2：y 轴 [0,60]，标签 "60" 窄 → plot.x 变小；**标注还开着**，
      // 这一步正是「布局变化 + 局部重绘」最容易留下残墨的组合
      chart.setDomain('y', [0, 60], 'api');
      await settle();
      const plotX2 = chart.layout.plot.x;
      const newPixel = chart.annotation.resolved.lines[0].pixel;
      const ink = chart.annotation.ink.map((box: any) => ({ ...box }));
      const withAnnotation = grab();

      // 同一布局下关掉标注
      chart.setOption(
        { ...base, yAxis: { min: 0, max: 60, name: '单量' }, annotation: undefined },
        { animate: false, preserveView: true }
      );
      await settle();
      const without = grab();

      let diff = 0;
      let outside = 0;
      const samples: Array<{ x: number; y: number }> = [];
      for (let y = 0; y < withAnnotation.height; y++) {
        for (let x = 0; x < withAnnotation.width; x++) {
          const i = (y * withAnnotation.width + x) * 4;
          if (
            withAnnotation.data[i] === without.data[i] &&
            withAnnotation.data[i + 1] === without.data[i + 1] &&
            withAnnotation.data[i + 2] === without.data[i + 2] &&
            withAnnotation.data[i + 3] === without.data[i + 3]
          ) {
            continue;
          }
          diff++;
          const covered = ink.some(
            (box: any) => x >= box.x - 3 && x <= box.x + box.width + 3 && y >= box.y - 3 && y <= box.y + box.height + 3
          );
          if (!covered) {
            outside++;
            if (samples.length < 8) samples.push({ x, y });
          }
        }
      }
      return { plotX1, plotX2, oldPixel, newPixel, ink, diff, outside, samples };
    });

    // 真的发生了布局变化，且标注确实挪了位置（不然这条测试什么也没验到）
    expect(result.plotX2).not.toBe(result.plotX1);
    expect(result.newPixel).not.toBe(result.oldPixel);
    expect(result.diff).toBeGreaterThan(100);
    expect(result.samples).toEqual([]);
    expect(result.outside).toBe(0);
  });
});
