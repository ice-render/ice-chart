import { layoutSankey } from '../../src/layout/sankey';
import type { SankeyOption } from '../../src/types';

const RECT = { x: 0, y: 0, width: 400, height: 300 };
const NODES = [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }];
const LINKS = [
  { source: 'A', target: 'C', value: 10 },
  { source: 'B', target: 'D', value: 10 },
];
const OPTION: SankeyOption = { nodes: NODES, links: LINKS };

/** 某一列里从上到下的节点名（看的是**排布结果**，不是输入顺序）。 */
function namesInColumn(layout: ReturnType<typeof layoutSankey>, depth: number): string[] {
  return layout.nodes
    .filter((node) => node.depth === depth)
    .sort((a, b) => a.y - b.y)
    .map((node) => node.name);
}

describe('layoutSankey 的列内顺序', () => {
  it('不给 nodeOrder 时由布局自己决定（同一列按松弛后的 y 排）', () => {
    const layout = layoutSankey(NODES, LINKS, RECT, OPTION);
    expect(namesInColumn(layout, 0)).toEqual(['A', 'B']);
    expect(namesInColumn(layout, 1)).toEqual(['C', 'D']);
  });

  it('把自动顺序原样写进 nodeOrder，结果逐值不变', () => {
    const auto = layoutSankey(NODES, LINKS, RECT, OPTION);
    const pinned = layoutSankey(NODES, LINKS, RECT, { ...OPTION, nodeOrder: ['A', 'B', 'C', 'D'] });
    expect(JSON.stringify(pinned)).toBe(JSON.stringify(auto));
  });

  it('给了 nodeOrder 就按它排 —— 松弛不许把顺序翻回来', () => {
    const layout = layoutSankey(NODES, LINKS, RECT, { ...OPTION, nodeOrder: ['B', 'A', 'D', 'C'] });
    expect(namesInColumn(layout, 0)).toEqual(['B', 'A']);
    expect(namesInColumn(layout, 1)).toEqual(['D', 'C']);
  });

  it('只列了部分节点时，没列到的排在它后面且保持原有相对顺序', () => {
    const layout = layoutSankey(NODES, LINKS, RECT, { ...OPTION, nodeOrder: ['B'] });
    expect(namesInColumn(layout, 0)).toEqual(['B', 'A']);
    expect(namesInColumn(layout, 1)).toEqual(['C', 'D']);
  });

  it('nodeOrder 里的节点可以用下标写', () => {
    const layout = layoutSankey(NODES, LINKS, RECT, { ...OPTION, nodeOrder: [1, 0] });
    expect(namesInColumn(layout, 0)).toEqual(['B', 'A']);
  });

  it('顺序变了也不许把节点挤出可用矩形', () => {
    const layout = layoutSankey(NODES, LINKS, RECT, { ...OPTION, nodeOrder: ['D', 'C', 'B', 'A'] });
    for (const node of layout.nodes) {
      expect(node.y).toBeGreaterThanOrEqual(RECT.y - 0.5);
      expect(node.y + node.height).toBeLessThanOrEqual(RECT.y + RECT.height + 0.5);
    }
  });
});
