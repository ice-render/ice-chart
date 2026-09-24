import { computePanelRects, panelIndexAt, resolveMatrix } from '../../src/layout/panels';

const AREA = { x: 40, y: 20, width: 600, height: 300 };

describe('resolveMatrix', () => {
  it('没有 matrix 时返回 null（单面板基线）', () => {
    expect(resolveMatrix(undefined)).toBeNull();
    expect(resolveMatrix(null)).toBeNull();
  });

  it('数字 = 等分权重', () => {
    const matrix = resolveMatrix({ rows: 2, columns: 3 })!;
    expect(matrix.rows).toEqual([1, 1]);
    expect(matrix.columns).toEqual([1, 1, 1]);
    expect(matrix.panelCount).toBe(6);
  });

  it('数组 = 权重（[4,1] 给主图 + 窄条）', () => {
    const matrix = resolveMatrix({ rows: [3, 1], columns: [4, 1] })!;
    expect(matrix.rows).toEqual([3, 1]);
    expect(matrix.columns).toEqual([4, 1]);
    expect(matrix.panelCount).toBe(4);
  });

  it('零 / 负 / 非有限 → 退化成 1；权重 ≤ 0 按 1 处理', () => {
    expect(resolveMatrix({ rows: 0, columns: -2 })!.panelCount).toBe(1);
    expect(resolveMatrix({ rows: [0, 2], columns: 2 })!.rows).toEqual([1, 2]);
    expect(resolveMatrix({ rows: NaN as any, columns: 1 })!.rows).toEqual([1]);
  });

  it('gap 默认 8，负数归 0', () => {
    expect(resolveMatrix({ rows: 1, columns: 1 })!.gap).toBe(8);
    expect(resolveMatrix({ rows: 1, columns: 1, gap: -3 })!.gap).toBe(0);
  });
});

describe('computePanelRects', () => {
  it('等分 2×3：行优先，且扣掉 gap', () => {
    const matrix = resolveMatrix({ rows: 2, columns: 3, gap: 10 })!;
    const panels = computePanelRects(AREA, matrix);
    expect(panels).toHaveLength(6);
    const colWidth = (600 - 20) / 3;
    const rowHeight = (300 - 10) / 2;
    expect(panels[0]).toEqual({ x: 40, y: 20, width: colWidth, height: rowHeight });
    expect(panels[2].x).toBeCloseTo(40 + colWidth * 2 + 20);
    expect(panels[3].y).toBeCloseTo(20 + rowHeight + 10);
    expect(panelIndexAt(panels, panels[4].x + 1, panels[4].y + 1)).toBe(4);
  });

  it('权重 4:1 的列宽比例正确', () => {
    const panels = computePanelRects(AREA, resolveMatrix({ rows: 1, columns: [4, 1], gap: 0 })!);
    expect(panels[1].width).toBeCloseTo(120);
    expect(panels[0].width).toBeCloseTo(480);
  });

  it('面板太小按 1px 兜底，不出负尺寸', () => {
    const matrix = resolveMatrix({ rows: 5, columns: 5, gap: 8 })!;
    const panels = computePanelRects({ x: 0, y: 0, width: 9, height: 9 }, matrix);
    for (const panel of panels) {
      expect(panel.width).toBeGreaterThanOrEqual(1);
      expect(panel.height).toBeGreaterThanOrEqual(1);
    }
  });

  it('panelIndexAt 落在缝隙里返回 -1', () => {
    const panels = computePanelRects(AREA, resolveMatrix({ rows: 1, columns: 2, gap: 20 })!);
    const gapX = panels[0].x + panels[0].width + 10;
    expect(panelIndexAt(panels, gapX, AREA.y + 5)).toBe(-1);
  });
});
