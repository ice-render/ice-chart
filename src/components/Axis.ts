import { ChartComponent } from './ChartComponent';
import type { ChartTheme } from '../types';
import type { AxisLayout, ChartLayout, InternalAxis } from '../internal';
import type { Rect } from '../internal';
import { formatTick } from '../scale';
import { measureTextWidth } from '../util/text';
import { shouldAnimate } from '../animation/motion';

const TICK_LENGTH = 4;
const LABEL_GAP = 6;
/** 刻度平滑过渡时长：缩放 / 平移 / 数据更新时，标签滑动到新位置而不是瞬间跳。 */
export const AXIS_MORPH_DURATION = 240;

interface AxisTickMark {
  /** 刻度值（字符串化）：跨帧匹配用，位置变了但值没变的刻度就是「同一根刻度」。 */
  key: string;
  /** 主轴方向的像素位置：x 轴是 x，y 轴是 y。 */
  pos: number;
  /** 格式化后的标签文本。 */
  label: string;
  /** 抽稀之后是否真的画标签（抽掉的刻度仍然画刻度线）。 */
  drawn: boolean;
}

/**
 * 坐标轴（x / y 共用一套绘制逻辑）。
 *
 * 轴组件拥有整块画布作为盒，绘制时直接用图表坐标系（左上角原点），
 * 因此刻度标签、轴名称可以自然画到绘图区之外，不需要扩展包围盒。
 *
 * 多 y 轴支持：`axisIndex` 决定读哪个轴的刻度，`position` + `layout.offset`
 * 决定轴线画在绘图区左侧还是右侧、以及同侧多轴时向外偏移多少。
 */
export class Axis extends ChartComponent {
  public orientation: 'x' | 'y';
  /** y 轴下标（对应 norm.yAxes）；x 轴恒为 0。 */
  public axisIndex = 0;
  public position: 'left' | 'right' = 'left';
  public axis: InternalAxis | null = null;
  public layout: ChartLayout | null = null;
  public theme: ChartTheme | null = null;
  /** 上一次同步的刻度（含像素位置），用于检测变化并作为过渡起点。 */
  private lastTicks: AxisTickMark[] = [];
  private morphFrom: AxisTickMark[] = [];

  constructor(props: {
    orientation: 'x' | 'y';
    width: number;
    height: number;
    zIndex?: number;
    axisIndex?: number;
    position?: 'left' | 'right';
  }) {
    super({ interactive: false, ...props });
    this.orientation = props.orientation;
    this.axisIndex = props.axisIndex || 0;
    this.position = props.position || 'left';
  }

  /** y 轴轴线的 x 坐标（含同侧多层偏移）。 */
  private edgeX(axisLayout: AxisLayout): number {
    const plot = (this.layout as ChartLayout).plot;
    const offset = axisLayout.offset || 0;
    return this.position === 'left' ? plot.x - offset : plot.x + plot.width + offset;
  }

  private axisLayoutOf(layout: ChartLayout): AxisLayout {
    return this.orientation === 'x' ? layout.xAxisLayout : layout.yAxes[this.axisIndex] || layout.yAxisLayout;
  }

  /** 当前刻度 + 目标位置 + 标签（抽稀规则与绘制时完全一致，两边共用这一份）。 */
  private tickEntries(): AxisTickMark[] | null {
    const axis = this.axis;
    const layout = this.layout;
    if (!axis || !layout || !axis.scale) return null;
    const option: any = axis.option || {};
    const scale = axis.scale;
    const plot = layout.plot;
    const axisLayout = this.axisLayoutOf(layout);
    const ticks = axisLayout.ticks;
    const fontSize = this.theme ? this.theme.fontSize : 12;
    const fontFamily = this.theme ? this.theme.fontFamily : 'sans-serif';

    // 标签抽稀：类目多的时候逐类目画标签会糊成一片，按可用宽度跳着画
    let labelStride = 1;
    if (this.orientation === 'x' && ticks.length > 1) {
      let maxLabel = 0;
      for (const text of axisLayout.labels) {
        const w = measureTextWidth(this.ctx, text, fontSize, fontFamily);
        if (w > maxLabel) maxLabel = w;
      }
      const slot = plot.width / ticks.length;
      // 舒适间隔 64px（2026-09-14 调整）：原来只要「标签宽度 + 8」不超槽宽就不稀释，
      // 于是 30 个刻度的数字标签虽然不重叠、也会挤成一片编号。
      const need = Math.max(maxLabel + 8, 64);
      if (need > slot) labelStride = Math.ceil(need / Math.max(1, slot));
    }

    const marks: AxisTickMark[] = [];
    for (let i = 0; i < ticks.length; i++) {
      const mapped = scale.map(ticks[i]);
      const pos = this.orientation === 'x' ? plot.x + mapped : plot.y + mapped;
      if (!isFinite(pos)) continue;
      const label = formatTick(ticks[i], scale, i, option.formatter) || '';
      const isLast = i === ticks.length - 1;
      const drawn = !!label && !(labelStride > 1 && i % labelStride !== 0 && !isLast);
      marks.push({ key: String(ticks[i]), pos, label, drawn });
    }
    return marks;
  }

  /** 过渡进度（0~1）；没有动画时恒为 1。 */
  private morphProgress(): number {
    const value = Number(this.state.axisMorph);
    return isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
  }

  /** 每个刻度「此刻画在哪」：过渡中会取中间位置。 */
  private renderedPositions(): Map<string, number> {
    const t = this.morphProgress();
    const out = new Map<string, number>();
    for (const tick of this.lastTicks) {
      const from = this.morphFrom.find((mark) => mark.key === tick.key);
      out.set(tick.key, from ? from.pos + (tick.pos - from.pos) * t : tick.pos);
    }
    return out;
  }

  /**
   * 同步刻度并（在必要时）启动一次平滑过渡。
   *
   * 由 ICEChart 在 `layout` / `axis` 赋值之后调用。判断完全基于「刻度集合有没有变」，
   * 所以缩放、平移、数据更新、图例切换、resize 都能自动覆盖，不需要调用方传意图。
   *
   * 过渡中的再次变化从**当前渲染位置**接着走（等价于指数平滑），
   * 连续滚轮缩放时不会出现「每次事件都从旧位置重新跳」的抖动。
   */
  public syncTicks(): void {
    const next = this.tickEntries();
    if (!next) return;
    const same =
      next.length === this.lastTicks.length &&
      next.every((tick, i) => tick.key === this.lastTicks[i].key && Math.abs(tick.pos - this.lastTicks[i].pos) < 0.01);
    if (same) return;
    const firstSync = this.lastTicks.length === 0;
    const rendered = this.renderedPositions();
    this.morphFrom = this.lastTicks.map((tick) => ({
      ...tick,
      pos: rendered.get(tick.key) ?? tick.pos,
    }));
    this.lastTicks = next;
    this.setState({ axisMorph: 0 });
    if (firstSync || !shouldAnimate()) {
      this.setState({ axisMorph: 1 });
      this.markDirty();
      return;
    }
    // props.animations 的默认值是引擎共享的冻结对象：复制后整体替换（踩过的坑）
    const animations: any = { ...((this.props as any).animations || {}) };
    animations.axisMorph = {
      from: 0,
      to: 1,
      duration: AXIS_MORPH_DURATION,
      easing: 'easeOutCubic',
      startTime: undefined,
      finished: false,
    };
    (this.props as any).animations = animations;
    if (this.ice && this.ice.animationManager) this.ice.animationManager.add(this);
    this.markDirty();
  }

  /** 某个刻度当前的渲染位置（过渡中间态）。测试 / 审计用。 */
  public renderedTickPos(value: any): number | null {
    const key = String(value);
    const from = this.morphFrom.find((mark) => mark.key === key);
    const to = this.lastTicks.find((mark) => mark.key === key);
    if (from && to) return from.pos + (to.pos - from.pos) * this.morphProgress();
    if (to) return to.pos;
    if (from) return from.pos;
    return null;
  }

  /** 位置是否还在过渡中（测试 / 审计用）。 */
  public morphing(): boolean {
    return this.morphProgress() < 1;
  }

  private drawTick(pos: number, plot: Rect, edgeX: number, unit: number, option: any): void {
    if (option.showTick === false) return;
    const ctx = this.ctx;
    ctx.beginPath();
    if (this.orientation === 'x') {
      ctx.moveTo(pos, plot.y + plot.height);
      ctx.lineTo(pos, plot.y + plot.height + TICK_LENGTH * unit);
    } else {
      const direction = this.position === 'left' ? -1 : 1;
      ctx.moveTo(edgeX, pos);
      ctx.lineTo(edgeX + direction * TICK_LENGTH * unit, pos);
    }
    ctx.stroke();
  }

  private drawTickLabel(pos: number, label: string, plot: Rect, edgeX: number, tickGap: number, option: any): void {
    if (!label) return;
    const ctx = this.ctx;
    if (this.orientation === 'x') {
      const labelY = plot.y + plot.height + tickGap;
      if (option.labelRotate) {
        ctx.save();
        ctx.translate(pos, labelY);
        ctx.rotate((Number(option.labelRotate) * Math.PI) / 180);
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, 0, 0);
        ctx.restore();
      } else {
        ctx.fillText(label, pos, labelY);
      }
      return;
    }
    const direction = this.position === 'left' ? -1 : 1;
    ctx.fillText(label, edgeX + direction * tickGap, pos);
  }

  protected doRender(): void {
    if (!this.axis || !this.layout || !this.theme) return;
    const option = this.axis.option;
    if (option.show === false) return;
    const scale = this.axis.scale;
    if (!scale) return;
    const plot = this.layout.plot;
    const axisLayout =
      this.orientation === 'x' ? this.layout.xAxisLayout : this.layout.yAxes[this.axisIndex] || this.layout.yAxisLayout;
    const ctx = this.ctx;
    const fontSize = this.theme.fontSize;
    const unit = this.unit();
    const tickGap = (TICK_LENGTH + LABEL_GAP) * unit;
    ctx.beginPath();
    ctx.save();
    ctx.lineWidth = unit;
    ctx.strokeStyle = this.theme.axisLineColor;
    ctx.fillStyle = this.theme.axisLabelColor;
    this.setFont(fontSize, this.theme.fontFamily);
    ctx.textBaseline = this.orientation === 'x' ? 'top' : 'middle';
    ctx.textAlign = this.orientation === 'x' ? 'center' : this.position === 'left' ? 'right' : 'left';

    const edgeX = this.orientation === 'x' ? plot.x : this.edgeX(axisLayout);

    if (option.showAxisLine !== false) {
      ctx.beginPath();
      if (this.orientation === 'x') {
        const y = this.snap(plot.y + plot.height);
        ctx.moveTo(plot.x, y);
        ctx.lineTo(plot.x + plot.width, y);
      } else {
        const x = this.snap(edgeX);
        ctx.moveTo(x, plot.y);
        ctx.lineTo(x, plot.y + plot.height);
      }
      ctx.stroke();
    }

    // 刻度的平滑过渡：保留的刻度从旧位置滑到新位置，新出现的淡入，消失的淡出。
    const direction = this.position === 'left' ? -1 : 1;
    const entries = this.tickEntries() || [];
    const t = this.morphProgress();
    const fromPos = new Map<string, number>();
    for (const mark of this.morphFrom) fromPos.set(mark.key, mark.pos);
    const liveKeys = new Set(entries.map((entry) => entry.key));

    if (t < 1) {
      // 已经不在刻度集合里的刻度：原地淡出（缩放时标签整体换一批，这条让过渡不「硬切」）
      ctx.fillStyle = this.theme.axisLabelColor;
      ctx.globalAlpha = (1 - t) * (1 - t);
      for (const mark of this.morphFrom) {
        if (liveKeys.has(mark.key) || !mark.drawn) continue;
        this.drawTick(mark.pos, plot, edgeX, unit, option);
        this.drawTickLabel(mark.pos, mark.label, plot, edgeX, tickGap, option);
      }
      ctx.globalAlpha = 1;
    }

    for (const entry of entries) {
      const start = fromPos.get(entry.key);
      const pos = start === undefined ? entry.pos : start + (entry.pos - start) * t;
      // 新出现的刻度淡入；一直在的刻度保持不透明（只滑动）
      ctx.globalAlpha = start === undefined ? Math.min(1, 0.15 + 0.85 * t) : 1;
      this.drawTick(pos, plot, edgeX, unit, option);
      if (entry.drawn) this.drawTickLabel(pos, entry.label, plot, edgeX, tickGap, option);
    }
    ctx.globalAlpha = 1;

    if (option.name) {
      this.setFont(fontSize, this.theme.fontFamily);
      ctx.fillStyle = this.theme.subTextColor;
      if (this.orientation === 'x') {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (this.layout.slider) {
          // 下方有 dataZoom 滑块时，轴名挪到轴线末端上方，避免压住滑块
          ctx.textAlign = 'right';
          ctx.textBaseline = 'bottom';
          ctx.fillText(option.name, plot.x + plot.width, plot.y + plot.height - 4 * unit);
        } else {
          const nameY = plot.y + plot.height + tickGap + axisLayout.labelHeight + 6 * unit + fontSize * 0.5;
          ctx.fillText(option.name, plot.x + plot.width / 2, nameY);
        }
      } else {
        const nameOffset = axisLayout.labelWidth + tickGap + axisLayout.nameHeight + 4 * unit;
        const nameX = edgeX + direction * nameOffset;
        ctx.save();
        ctx.translate(this.position === 'left' ? Math.max(fontSize * 0.6, nameX) : nameX, plot.y + plot.height / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(option.name, 0, 0);
        ctx.restore();
      }
    }
    ctx.restore();
  }
}
