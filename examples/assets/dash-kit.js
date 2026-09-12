/**
 * 大屏脚手架：三个大屏示例（运营 / 设备 / 行情）共用的那部分。
 *
 * 一个页面要做的事只剩三件：配色（覆盖 CSS 变量）、面板清单（DashKit.panel）、数据怎么动（tick）。
 *
 * 约定（与仓库其它示例一致，审计脚本也认这套）：
 * - `window.__chart` / `window.__charts` / `window.__link` 用于审计与 JSON 面板；
 * - 页面底部有 `#snapshot-panel`；
 * - 所有面板的宽度都是 12 列栅格的整数倍（列宽 120、间距 12），画布宽 = 面板宽 − 16 − 2，
 *   这样不同页面之间、同一页面内所有面板的边缘与留白都严格对齐。
 */
(function (global) {
  var COL = 120;
  var GAP = 12;

  /** 列宽 → 画布宽（面板内边距 8×2 + 边框 1×2）。 */
  function canvasWidth(span) {
    return span * COL + (span - 1) * GAP - 18;
  }

  /** 面板 HTML：标题栏（3px 强调条 + 标题 + 右侧元信息）+ 画布。 */
  function panel(options) {
    var span = options.span || 3;
    return (
      '<section class="dk-panel dk-span' + span + '"' + (options.id ? ' id="panel-' + options.id + '"' : '') + '>' +
      '<header class="dk-panel-title">' + options.title +
      (options.meta ? '<span class="dk-meta">' + options.meta + '</span>' : '') +
      '</header>' +
      '<canvas id="' + options.id + '" width="' + canvasWidth(span) + '" height="' + options.height + '"></canvas>' +
      '</section>'
    );
  }

  /** KPI 条：一条整宽 + 竖直分隔线（cells: [{id,label,unit,value,trend}]）。 */
  function kpiStrip(cells) {
    var html = cells.map(function (cell) {
      return (
        '<div class="dk-kpi" id="' + cell.id + '">' +
        '<div class="dk-label">' + cell.label + '</div>' +
        '<div class="dk-value">0<small>' + (cell.unit || '') + '</small></div>' +
        '<div class="dk-trend">▲ 0.0%</div>' +
        '</div>'
      );
    }).join('');
    return '<div class="dk-kpis">' + html + '</div>';
  }

  /**
   * KPI 更新器：返回 update(id, value, text, invert)。
   * `invert` 用于「越小越好」的指标（延迟、错误率）：下降显示绿色。
   */
  function kpiUpdater() {
    var prev = {};
    return function (id, value, text, invert) {
      var box = global.document.getElementById(id);
      if (!box) return;
      box.querySelector('.dk-value').innerHTML = text;
      var base = prev[id] || 0;
      var delta = base ? ((value - base) / base) * 100 : 0;
      prev[id] = value;
      var trend = box.querySelector('.dk-trend');
      trend.textContent = (delta >= 0 ? '▲ ' : '▼ ') + Math.abs(delta).toFixed(1) + '%';
      trend.classList.toggle('dk-down', invert ? delta > 0 : delta < 0);
      box.classList.toggle('dk-alert', !!box.dataset.threshold && value > Number(box.dataset.threshold));
    };
  }

  /** 带惯性的随机游走：监控数据比纯随机像样得多。 */
  function walk(value, target, volatility, inertia) {
    return value + (target - value) * (inertia === undefined ? 0.08 : inertia) + (Math.random() - 0.5) * volatility;
  }

  /** 主循环：按 60Hz 推进，带暂停与倍速；返回控制器。 */
  function loop(options) {
    var state = { running: true, speed: options && options.speed ? options.speed : 1 };
    var last = performance.now();
    var budget = 0;
    function frame(now) {
      var delta = Math.min(100, now - last);
      last = now;
      if (state.running) {
        budget += (delta / 16.7) * state.speed;
        var guard = 0;
        while (budget >= 1 && guard < 6) {
          options.tick();
          budget -= 1;
          guard += 1;
        }
      }
      if (options.onFrame) options.onFrame(now);
      global.requestAnimationFrame(frame);
    }
    global.requestAnimationFrame(frame);
    var controller = {
      state: state,
      toggle: function () {
        state.running = !state.running;
        return state.running;
      },
      setSpeed: function (speed) {
        state.speed = speed;
      },
    };
    // 暴露给「像素缓存新鲜度」检测：它需要在比对期间暂停数据流（否则「缓存落后一帧」会被误判成陈旧）
    global.__dashLoop = controller;
    return controller;
  }

  /** 挂上审计/快照需要的全局句柄。 */
  function wire(options) {
    global.__chart = options.main;
    global.__charts = options.charts;
    if (options.link) global.__link = options.link;
    if (global.mountSnapshotPanel) global.mountSnapshotPanel();
  }

  /** 图表主题：在 dark 主题上换掉网格线 / 坐标轴 / 提示框 / 准星的取色。 */
  function chartTheme(identity) {
    return {
      colorPalette: identity.palette,
      textColor: identity.text,
      // 轴文字与轴名称都必须近灰：它们画在轴带上，颜色太蓝/太绿（通道极差 > 45）
      // 会被「越界墨迹」审计判成「图形画到了坐标轴上」。图例文字另算（它在顶部，不参与该审计）。
      subTextColor: identity.textDim,
      axisLineColor: identity.axisLine,
      axisLabelColor: identity.axisLabel,
      splitLineColor: identity.splitLine,
      labelHaloColor: identity.halo,
      legend: { textColor: identity.textDim, inactiveColor: identity.inactive },
      tooltip: { background: identity.tooltipBg, borderColor: identity.tooltipBorder, textColor: identity.text },
      crosshair: { lineColor: identity.crosshair, labelBackground: identity.chipBg, labelColor: identity.chipText },
      brush: { fill: identity.brushFill, stroke: identity.brushStroke },
      selection: { stroke: identity.accent, dimOpacity: 0.35 },
    };
  }

  var CSS = [
    ':root {',
    '  --dk-col: 120px; --dk-gap: 12px;',
    '  --dk-bg: #030711; --dk-bg-2: #04101f;',
    '  --dk-panel: rgba(9, 32, 52, 0.55); --dk-panel-2: rgba(6, 20, 36, 0.85);',
    '  --dk-line: rgba(0, 229, 255, 0.16); --dk-corner: rgba(0, 229, 255, 0.75);',
    '  --dk-accent: #00e5ff; --dk-accent-soft: rgba(0, 229, 255, 0.08);',
    '  --dk-text: #e6f1ff; --dk-text-dim: #9fb6d4; --dk-muted: #6b83a6;',
    '  --dk-ok: #22c55e; --dk-warn: #fac858; --dk-danger: #ff5b6a;',
    '  --dk-font: system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;',
    '  --dk-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Roboto Mono", monospace;',
    '}',
    '* { box-sizing: border-box; }',
    'html, body { margin: 0; padding: 0; min-height: 100%;',
    '  background: radial-gradient(900px 420px at 50% -8%, var(--dk-glow), transparent 62%),',
    '    radial-gradient(700px 380px at 8% 6%, var(--dk-glow-2, transparent), transparent 60%),',
    '    linear-gradient(180deg, var(--dk-bg-2) 0%, var(--dk-bg) 42%, #01040c 100%);',
    '  color: var(--dk-text); font-family: var(--dk-font); font-size: 14px; }',
    'body::before { content: ""; position: fixed; inset: 0; pointer-events: none;',
    '  background-image: radial-gradient(var(--dk-dots, rgba(0, 229, 255, 0.09)) 1px, transparent 1px);',
    '  background-size: 26px 26px;',
    '  mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.9), transparent 78%);',
    '  -webkit-mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.9), transparent 78%); }',
    '.dk-screen { position: relative; width: calc(var(--dk-col) * 12 + var(--dk-gap) * 11); margin: 0 auto;',
    '  padding: 10px 0 18px; display: grid; grid-template-columns: repeat(12, var(--dk-col));',
    '  gap: var(--dk-gap); align-content: start; }',
    '.dk-topbar { grid-column: span 12; position: relative; height: 58px; display: flex; align-items: center;',
    '  justify-content: center; border-bottom: 1px solid var(--dk-line);',
    '  background: linear-gradient(180deg, var(--dk-accent-soft), transparent); }',
    '.dk-topbar::after { content: ""; position: absolute; left: 50%; bottom: -1px; width: 320px; height: 2px;',
    '  transform: translateX(-50%); background: linear-gradient(90deg, transparent, var(--dk-accent), transparent);',
    '  box-shadow: 0 0 12px var(--dk-accent); }',
    '.dk-topbar h1 { margin: 0; font-size: 26px; font-weight: 600; letter-spacing: 6px;',
    '  text-shadow: 0 0 18px var(--dk-glow-text, rgba(0, 229, 255, 0.45)); }',
    '.dk-wing { position: absolute; top: 50%; width: 300px; height: 1px;',
    '  background: linear-gradient(90deg, transparent, var(--dk-corner)); }',
    '.dk-wing.left { left: 210px; } .dk-wing.right { right: 210px; transform: scaleX(-1); }',
    '.dk-wing::after { content: ""; position: absolute; right: 0; top: -2px; width: 5px; height: 5px;',
    '  background: var(--dk-accent); box-shadow: 0 0 8px var(--dk-accent); }',
    '.dk-side { position: absolute; top: 0; height: 100%; display: flex; align-items: center; gap: 10px; }',
    '.dk-side.left { left: 0; } .dk-side.right { right: 0; }',
    '.dk-pill { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px;',
    '  border: 1px solid var(--dk-line); border-radius: 2px; background: var(--dk-accent-soft);',
    '  font-family: var(--dk-mono); font-size: 12px; color: var(--dk-muted); white-space: nowrap; }',
    '.dk-pill b { color: var(--dk-text); font-weight: 600; }',
    '.dk-pill.ok { color: var(--dk-ok); border-color: rgba(34, 197, 94, 0.45); }',
    '.dk-pill.danger { color: var(--dk-danger); border-color: rgba(255, 91, 106, 0.55);',
    '  background: rgba(255, 91, 106, 0.1); animation: dk-blink 1.1s steps(2, end) infinite; }',
    '@keyframes dk-blink { 50% { opacity: 0.45; } }',
    '.dk-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 8px currentColor; }',
    'button.dk-ghost { font: inherit; font-size: 12px; height: 24px; padding: 0 12px; border: 1px solid var(--dk-line);',
    '  border-radius: 2px; background: var(--dk-accent-soft); color: var(--dk-text-dim); cursor: pointer; }',
    'button.dk-ghost:hover { border-color: var(--dk-accent); color: #fff; }',
    '.dk-panel { position: relative; border: 1px solid var(--dk-line); padding: 8px;',
    '  background: linear-gradient(180deg, var(--dk-panel) 0%, var(--dk-panel-2) 100%); }',
    '.dk-panel::before { content: ""; position: absolute; inset: -1px; pointer-events: none;',
    '  background-image: linear-gradient(var(--dk-corner), var(--dk-corner)), linear-gradient(var(--dk-corner), var(--dk-corner)),',
    '    linear-gradient(var(--dk-corner), var(--dk-corner)), linear-gradient(var(--dk-corner), var(--dk-corner)),',
    '    linear-gradient(var(--dk-corner), var(--dk-corner)), linear-gradient(var(--dk-corner), var(--dk-corner)),',
    '    linear-gradient(var(--dk-corner), var(--dk-corner)), linear-gradient(var(--dk-corner), var(--dk-corner));',
    '  background-repeat: no-repeat;',
    '  background-size: 14px 2px, 2px 14px, 14px 2px, 2px 14px, 14px 2px, 2px 14px, 14px 2px, 2px 14px;',
    '  background-position: left top, left top, right top, right top, left bottom, left bottom, right bottom, right bottom; }',
    // 1~12 列全给出来：只定义常用几档时，写一个没定义的 span 会退化成「自动占 1 列」，
    // 结果是两个面板叠在同一个格子里（实测：span 9 撞上隔壁 span 3，两张画布正好压在一起）。
    '.dk-span1 { grid-column: span 1; } .dk-span2 { grid-column: span 2; } .dk-span3 { grid-column: span 3; }',
    '.dk-span4 { grid-column: span 4; } .dk-span5 { grid-column: span 5; } .dk-span6 { grid-column: span 6; }',
    '.dk-span7 { grid-column: span 7; } .dk-span8 { grid-column: span 8; } .dk-span9 { grid-column: span 9; }',
    '.dk-span10 { grid-column: span 10; } .dk-span11 { grid-column: span 11; } .dk-span12 { grid-column: span 12; }',
    '.dk-panel.dk-alert { border-color: rgba(255, 91, 106, 0.6); box-shadow: inset 0 0 26px rgba(255, 91, 106, 0.12); }',
    '.dk-panel.dk-alert::before { --dk-corner: var(--dk-danger); }',
    '.dk-panel-title { display: flex; align-items: center; gap: 8px; height: 26px; margin-bottom: 6px;',
    '  font-size: 14px; letter-spacing: 0.5px; }',
    '.dk-panel-title::before { content: ""; width: 3px; height: 13px; background: var(--dk-accent);',
    '  box-shadow: 0 0 8px var(--dk-accent); }',
    '.dk-meta { margin-left: auto; font-family: var(--dk-mono); font-size: 11px; font-weight: 400;',
    '  color: var(--dk-muted); letter-spacing: 0; }',
    'canvas { display: block; touch-action: none; }',
    '.dk-kpis { grid-column: span 12; display: grid; grid-template-columns: repeat(5, 1fr);',
    '  border: 1px solid var(--dk-line);',
    '  background: linear-gradient(180deg, var(--dk-panel) 0%, var(--dk-panel-2) 100%); }',
    '.dk-kpi { position: relative; padding: 12px 18px 13px; display: flex; flex-direction: column; gap: 4px; }',
    '.dk-kpi + .dk-kpi::before { content: ""; position: absolute; left: 0; top: 12px; bottom: 12px; width: 1px;',
    '  background: linear-gradient(180deg, transparent, var(--dk-accent-soft-strong, rgba(0, 229, 255, 0.35)), transparent); }',
    '.dk-kpi .dk-label { font-size: 13px; color: var(--dk-text-dim); letter-spacing: 1px; }',
    '.dk-kpi .dk-value { font-family: var(--dk-mono); font-size: 30px; line-height: 1.1; font-weight: 600;',
    '  font-variant-numeric: tabular-nums; color: var(--dk-accent); text-shadow: 0 0 18px var(--dk-glow-text, rgba(0, 229, 255, 0.35)); }',
    '.dk-kpi .dk-value small { font-size: 12px; font-weight: 400; color: var(--dk-muted); margin-left: 6px; }',
    '.dk-kpi .dk-trend { font-family: var(--dk-mono); font-size: 12px; color: var(--dk-ok); }',
    '.dk-kpi .dk-trend.dk-down { color: var(--dk-danger); }',
    '.dk-kpi.dk-alert .dk-value { color: var(--dk-danger); }',
    '.dk-footer { grid-column: span 12; display: flex; justify-content: space-between; align-items: center;',
    '  color: var(--dk-muted); font-size: 12px; }',
    '.dk-footer code { color: var(--dk-accent); font-family: var(--dk-mono); }',
    '#snapshot-panel { grid-column: span 12; border: 1px solid var(--dk-line); background: var(--dk-panel-2); padding: 10px 12px; }',
    '#snapshot-panel .snapshot-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }',
    '#snapshot-panel .snapshot-title { font-size: 13px; }',
    '#snapshot-panel .spacer { flex: 1 1 auto; }',
    '#snapshot-panel .snapshot-meta, #snapshot-panel .snapshot-note { color: var(--dk-muted); font-size: 11px; }',
    '#snapshot-panel .snapshot-tabs { display: inline-flex; flex-wrap: wrap; gap: 4px; }',
    '#snapshot-panel button { font: inherit; font-size: 11px; padding: 2px 8px; border-radius: 2px;',
    '  border: 1px solid var(--dk-line); background: var(--dk-accent-soft); color: var(--dk-muted); cursor: pointer; }',
    '#snapshot-panel button:hover { border-color: var(--dk-accent); color: var(--dk-text); }',
    '#snapshot-panel .snapshot-tabs button.active { border-color: var(--dk-accent); color: var(--dk-accent); }',
    '#snapshot-panel .snapshot-json { margin: 0; padding: 8px 10px; max-height: 14rem; overflow: auto;',
    '  border: 1px solid var(--dk-line); background: rgba(2, 8, 18, 0.92); color: var(--dk-text-dim);',
    '  font-family: var(--dk-mono); font-size: 11px; line-height: 1.6; white-space: pre; }',
    '#snapshot-panel .tok-key { color: #6edff6; } #snapshot-panel .tok-str { color: #79dfc1; }',
    '#snapshot-panel .tok-num { color: #fac858; } #snapshot-panel .tok-bool { color: #e685b5; }',
    '#snapshot-panel .tok-null { color: var(--dk-muted); }',
  ].join('\n');

  function injectStyle() {
    if (global.document.getElementById('dk-style')) return;
    var style = global.document.createElement('style');
    style.id = 'dk-style';
    style.textContent = CSS;
    global.document.head.appendChild(style);
  }

  global.DashKit = {
    injectStyle: injectStyle,
    canvasWidth: canvasWidth,
    panel: panel,
    kpiStrip: kpiStrip,
    kpiUpdater: kpiUpdater,
    walk: walk,
    loop: loop,
    wire: wire,
    chartTheme: chartTheme,
    COL: COL,
    GAP: GAP,
  };
})(window);
