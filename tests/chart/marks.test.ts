import { ICERect, ICEStar, ICEText } from 'ice-render';
import { createChart } from '../../src/index';
import type { ICEChart } from '../../src/ICEChart';
import type { ChartOption } from '../../src/types';

const OPTION: ChartOption = {
  xAxis: { type: 'category', data: ['1月', '2月', '3月', '4月'] },
  yAxis: { min: 0, max: 200 },
  series: [{ id: 's', type: 'line', name: '销量', data: [120, 142, 168, 154] }],
};

/**
 * 数据坐标图元：把任意引擎图元挂到数据坐标上。
 *
 * 这条能力是「图表即引擎场景」的直接兑现 —— 组件是调用方创建的引擎图元，
 * 所以它天然带命中测试、事件与动画；chart 负责摆位、跟随、越界隐藏与拖拽回传。
 */
describe('数据坐标图元（mark）', () => {
  let canvas: HTMLCanvasElement;
  let chart: ICEChart | null = null;

  const mount = (option: ChartOption = OPTION) => {
    canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 400;
    document.body.appendChild(canvas);
    chart = createChart(canvas, option);
    return chart;
  };

  afterEach(() => {
    if (chart) chart.destroy();
    chart = null;
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
  });

  /** 组件绘制盒的左上角 —— 引擎里 left/top 就是左上角（origin 只影响变换枢轴）。 */
  const boxOf = (component: any) => {
    const st = component.state;
    return { left: st.left, top: st.top, width: st.width, height: st.height };
  };
  /** 组件中心。 */
  const centerOf = (component: any): [number, number] => {
    const box = boxOf(component);
    return [box.left + box.width / 2, box.top + box.height / 2];
  };

  const expectPixel = (x: number, y: number) => {
    const plot = chart!.layout.plot;
    const scale: any = chart!.norm.xAxis.scale;
    const yScale: any = chart!.norm.yAxis.scale;
    return [plot.x + scale.map(x), plot.y + yScale.map(y)];
  };

  it('point：图元中心落在数据点上，且随缩放 / 平移跟随', async () => {
    const c = mount();
    const star = new ICEStar({ radius: 10, spikes: 5, fill: true, style: { fillStyle: '#dc3545' } });
    const mark = c.addMark({ type: 'point', x: '3月', y: 168, component: star });
    await c.render();

    const [px, py] = expectPixel('3月', 168);
    expect(centerOf(star)[0]).toBeCloseTo(px, 0);
    expect(centerOf(star)[1]).toBeCloseTo(py, 0);

    // 缩放（x 域变化）后，图元必须重新贴回数据点
    c.setDomain('x', ['2月', '4月'], 'zoom');
    await c.render();
    const [px2] = expectPixel('3月', 168);
    expect(px2).not.toBeCloseTo(px, 0);
    expect(centerOf(star)[0]).toBeCloseTo(px2, 0);
    mark.remove();
  });

  it('xLine / yLine：跨满绘图区；yBand：整幅横向区间', async () => {
    const c = mount();
    const vLine = new ICERect({ width: 2, height: 1, fill: true, style: { fillStyle: '#dc3545' } });
    const hLine = new ICERect({ width: 1, height: 2, fill: true, style: { fillStyle: '#198754' } });
    const band = new ICERect({ width: 1, height: 1, fill: true, style: { fillStyle: 'rgba(13,110,253,0.12)' } });
    c.addMark({ type: 'xLine', x: '3月', component: vLine });
    c.addMark({ type: 'yLine', y: 160, component: hLine });
    c.addMark({ type: 'yBand', y0: 120, y1: 150, component: band });
    await c.render();
    const plot = c.layout.plot;
    expect(boxOf(vLine).height).toBe(plot.height);
    expect(boxOf(hLine).width).toBe(plot.width);
    expect(boxOf(band).width).toBe(plot.width);
    const [px] = expectPixel('3月', 0);
    expect(centerOf(vLine)[0]).toBeCloseTo(px, 0);
    const [, yHigh] = expectPixel('3月', 150);
    const [, yLow] = expectPixel('3月', 120);
    expect(boxOf(band).top).toBeCloseTo(Math.min(yHigh, yLow), 0);
    expect(boxOf(band).height).toBeCloseTo(Math.abs(yLow - yHigh), 0);
  });

  it('图元是引擎一等公民：命中测试能点到它，并且不破坏图表的悬停', async () => {
    const c = mount();
    const card = new ICERect({ width: 80, height: 30, radius: 4, fill: true, stroke: true, interactive: true, style: { fillStyle: '#fff', strokeStyle: '#0d6efd' } });
    c.addMark({ type: 'point', x: '2月', y: 142, component: card });
    await c.render();
    const dpr = c.ice.dpr || 1;
    const hit = c.ice.hitTest((card.state.left + 4) * dpr, (card.state.top + 4) * dpr);
    expect(hit).toBe(card);
    expect(c.isMarkComponent(card)).toBe(true);

    // 图表自己的数据悬停照常
    const comp: any = c.seriesComponents[0];
    const pixel = comp.pixelAt(1)!;
    c.controller.handlePointerMove(c.layout.plot.x + pixel[0], c.layout.plot.y + pixel[1]);
    await c.render();
    expect(comp.hoverIndex).toBe(1);
  });

  it('数据点移出可视区时自动隐藏（可关）', async () => {
    const c = mount();
    const star = new ICEStar({ radius: 8, fill: true, style: { fillStyle: '#dc3545' } });
    c.addMark({ type: 'point', x: '1月', y: 120, component: star });
    c.addMark({ type: 'point', x: '4月', y: 154, component: new ICEStar({ radius: 8 }), hideWhenOutOfView: false });
    await c.render();
    c.setDomain('x', ['3月', '4月'], 'zoom');
    await c.render();
    expect(star.state.display).toBe(false);
    const marks = c.getMarks();
    expect(marks[1].component.state.display).not.toBe(false);
  });

  it('拖拽：写回数据坐标并抛 mark:drag / mark:dragend', async () => {
    const c = mount();
    const dragged: any[] = [];
    c.on('mark:drag', (data: any) => dragged.push(data));
    const ended: any[] = [];
    c.on('mark:dragend', (data: any) => ended.push(data));
    const rect = new ICERect({ width: 12, height: 12, fill: true, draggable: true, interactive: true, style: { fillStyle: '#dc3545' } });
    const mark = c.addMark({ type: 'yLine', y: 120, component: rect });
    await c.render();

    // 模拟引擎把图元拖到 y=160 的位置（组件自己的拖拽最终就是改 left/top）
    const plot = c.layout.plot;
    const yScale: any = c.norm.yAxis.scale;
    const targetTop = plot.y + yScale.map(160) - rect.state.height / 2;
    rect.setPosition(rect.state.left, targetTop);
    expect(dragged.length).toBeGreaterThan(0);
    expect(dragged[dragged.length - 1].yValue).toBeCloseTo(160, 0);
    expect(mark.spec.y).toBeCloseTo(160, 0); // 锚点已写回

    c.controller.handlePointerUp(0, 0);
    expect(ended.length).toBe(1);
    expect(ended[0].yValue).toBeCloseTo(160, 0);
  });

  it('addMark 的基本校验 / 生命周期', async () => {
    const c = mount();
    expect(() => c.addMark({ component: null as any })).toThrow(/component/);
    expect(() => c.addMark({ type: 'nope' as any, component: new ICERect({}) })).toThrow(/不支持的 type/);
    const star = new ICEStar({ radius: 6 });
    const handle = c.addMark({ id: 'mine', x: '1月', y: 120, component: star });
    expect(handle.id).toBe('mine');
    expect(() => c.addMark({ id: 'mine', component: new ICEStar({}) })).toThrow(/已经存在/);
    expect(c.getMarks()).toHaveLength(1);
    expect(c.getMark('mine')!.component).toBe(star);
    handle.update({ y: 180 });
    expect(handle.spec.y).toBe(180);
    expect(handle.toData().yValue).toBeCloseTo(180, 0);
    expect(c.removeMark('mine')).toBe(true);
    expect(c.isMarkComponent(star)).toBe(false);
    expect(c.getMarks()).toHaveLength(0);
  });

  it('图元可以带文本（注释卡片），并且不参与图表的数据命中', async () => {
    const c = mount();
    const label = new ICEText({ text: '异常', style: { fillStyle: '#dc3545', fontSize: 12 } });
    c.addMark({ type: 'point', x: '3月', y: 168, component: label });
    await c.render();
    const comp: any = c.seriesComponents[0];
    const pixel = comp.pixelAt(0)!;
    c.controller.handlePointerMove(c.layout.plot.x + pixel[0], c.layout.plot.y + pixel[1]);
    await c.render();
    expect(comp.hoverIndex).toBe(0);
    expect(c.getMarks()[0].component.state.text).toBe('异常');
  });
});
