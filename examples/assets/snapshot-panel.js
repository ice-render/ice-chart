/**
 * 序列化 JSON 面板：把图表的真实快照（chart.toJSON()）实时显示出来。
 *
 * 用法（放在页面图表脚本之后的 <script> 里）：
 *   mountSnapshotPanel();                       // 自动发现 window.__chart / __charts / __link.charts
 *   mountSnapshotPanel({ charts: { '主图': chart }, container: '#snapshot-panel' });
 *
 * 面板会在 缩放 / 平移 / 图例切换 之后自动刷新（防抖 150ms），也可以手动 refresh()。
 * 大负载（如 5 万点）只显示前若干字符，完整内容请用「复制」或「下载」。
 */
(function (global) {
  var MAX_DISPLAY = 8000;

  function escapeHtml(text) {
    return String(text).replace(/[&<>]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;';
    });
  }

  /** 极简 JSON 语法高亮（先转义，再套 span，保证安全）。 */
  function highlight(json) {
    return escapeHtml(json).replace(
      /("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
      function (match) {
        var cls = 'num';
        if (/^"/.test(match)) cls = /:$/.test(match) ? 'key' : 'str';
        else if (/^(true|false)$/.test(match)) cls = 'bool';
        else if (match === 'null') cls = 'null';
        return '<span class="tok-' + cls + '">' + match + '</span>';
      }
    );
  }

  function isChart(candidate) {
    return !!candidate && typeof candidate.toJSON === 'function' && !!candidate.norm;
  }

  function discover() {
    var found = [];
    var seen = [];
    function push(chart, label) {
      if (!isChart(chart) || seen.indexOf(chart) !== -1) return;
      seen.push(chart);
      found.push({ label: label, chart: chart });
    }
    push(global.__chart, '图表');
    if (global.__charts) {
      Object.keys(global.__charts).forEach(function (key) {
        push(global.__charts[key], key);
      });
    }
    if (global.__link && Array.isArray(global.__link.charts)) {
      global.__link.charts.forEach(function (chart, i) {
        push(chart, '图表 ' + (i + 1));
      });
    }
    return found;
  }

  function formatSize(text) {
    var bytes = text.length;
    return bytes < 1024 ? bytes + ' B' : (bytes / 1024).toFixed(1) + ' KB';
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  /**
   * 生成「给人看」的预览副本：长数组只保留前若干项，并插入省略标记。
   * 5 万点的图表完整快照有 11MB，直接美化既慢又没人读得下去 ——
   * 但复制 / 下载拿到的仍然是完整快照。
   */
  function makePreview(value, maxItems, info) {
    if (Array.isArray(value)) {
      var head = value.slice(0, maxItems).map(function (item) {
        return makePreview(item, maxItems, info);
      });
      if (value.length > maxItems) {
        info.omitted = true;
        head.push('… 省略 ' + (value.length - maxItems) + ' 项（完整内容见复制 / 下载）');
      }
      return head;
    }
    if (value && typeof value === 'object') {
      var out = {};
      Object.keys(value).forEach(function (key) {
        out[key] = makePreview(value[key], maxItems, info);
      });
      return out;
    }
    return value;
  }

  function mount(options) {
    var opts = options || {};
    var container =
      typeof opts.container === 'string' ? document.querySelector(opts.container) : opts.container || document.querySelector('#snapshot-panel');
    if (!container) return null;

    var entries;
    if (opts.charts && !Array.isArray(opts.charts)) {
      entries = Object.keys(opts.charts).map(function (label) {
        return { label: label, chart: opts.charts[label] };
      });
    } else if (Array.isArray(opts.charts)) {
      entries = opts.charts.map(function (chart, i) {
        return { label: '图表 ' + (i + 1), chart: chart };
      });
    } else {
      entries = discover();
    }
    entries = entries.filter(function (entry) {
      return isChart(entry.chart);
    });
    if (!entries.length) return null;

    var active = 0;
    var full = '';
    var timer = null;

    container.innerHTML =
      '<div class="snapshot-head">' +
      '<span class="snapshot-title">序列化 JSON</span>' +
      '<span class="snapshot-tabs"></span>' +
      '<span class="spacer"></span>' +
      '<span class="snapshot-meta"></span>' +
      '<span class="snapshot-actions">' +
      '<button type="button" data-act="refresh">刷新</button>' +
      '<button type="button" data-act="copy">复制</button>' +
      '<button type="button" data-act="download">下载</button>' +
      '</span>' +
      '</div>' +
      '<pre class="snapshot-json"></pre>' +
      '<div class="snapshot-note"></div>';

    var tabsEl = container.querySelector('.snapshot-tabs');
    var metaEl = container.querySelector('.snapshot-meta');
    var jsonEl = container.querySelector('.snapshot-json');
    var noteEl = container.querySelector('.snapshot-note');

    function activeEntry() {
      return entries[active];
    }

    function renderJson() {
      var entry = activeEntry();
      var snapshot = entry.chart.toJSON();
      // 完整内容：紧凑字符串（体积小、复制/下载用它）
      full = JSON.stringify(snapshot);
      // 展示内容：截断长数组后美化
      var previewInfo = { omitted: false };
      var pretty = JSON.stringify(makePreview(snapshot, opts.maxArrayItems || 40, previewInfo), null, 2);
      var truncated = pretty.length > MAX_DISPLAY;
      var shown = truncated ? pretty.slice(0, MAX_DISPLAY) : pretty;
      jsonEl.innerHTML = highlight(shown) + (truncated ? '\n<span class="tok-null">…（预览已截断）</span>' : '');
      var seriesCount = (snapshot.option && snapshot.option.series ? snapshot.option.series.length : 0) || 0;
      var hiddenSeries = Object.keys(snapshot.hidden || {}).filter(function (key) {
        return snapshot.hidden[key];
      });
      var hiddenSlices = Object.keys(snapshot.hiddenSlices || {}).filter(function (key) {
        return snapshot.hiddenSlices[key];
      });
      metaEl.textContent =
        'v' +
        snapshot.version +
        ' ｜ ' +
        '快照 ' +
        formatBytes(full.length) +
        (previewInfo.omitted ? '（预览 ' + formatSize(pretty) + '）' : '') +
        ' ｜ 系列 ' +
        seriesCount +
        (hiddenSeries.length ? ' ｜ 隐藏 ' + hiddenSeries.join(',') : '') +
        (hiddenSlices.length ? ' ｜ 隐藏扇区 ' + hiddenSlices.join(',') : '') +
        ' ｜ 更新于 ' +
        new Date().toLocaleTimeString();
      noteEl.textContent =
        previewInfo.omitted || truncated
          ? '预览为了可读性截断了长数组；「复制 / 下载」拿到的是完整快照（' + formatBytes(full.length) + '）。'
          : '这是 chart.toJSON() 的真实内容：option（声明式规格）+ view（缩放窗口）+ hidden / hiddenSlices（显隐）。';
    }

    function renderTabs() {
      if (entries.length <= 1) {
        tabsEl.innerHTML = '';
        return;
      }
      tabsEl.innerHTML = entries
        .map(function (entry, index) {
          return '<button type="button" data-index="' + index + '"' + (index === active ? ' class="active"' : '') + '>' + entry.label + '</button>';
        })
        .join('');
    }

    function refresh() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      renderTabs();
      renderJson();
    }

    /** 高频事件（滚轮缩放）防抖，避免大负载下每次 tick 都 stringify。 */
    function scheduleRefresh() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 150);
    }

    tabsEl.addEventListener('click', function (event) {
      var index = event.target && event.target.getAttribute && event.target.getAttribute('data-index');
      if (index === null || index === undefined) return;
      active = Number(index);
      refresh();
    });

    container.querySelector('.snapshot-actions').addEventListener('click', function (event) {
      var act = event.target && event.target.getAttribute && event.target.getAttribute('data-act');
      if (act === 'refresh') {
        refresh();
        return;
      }
      if (act === 'copy') {
        if (global.navigator && navigator.clipboard) {
          navigator.clipboard.writeText(full).then(
            function () {
              noteEl.textContent = '已复制完整快照（' + formatSize(full) + '）到剪贴板。';
            },
            function () {
              noteEl.textContent = '复制失败，可改用「下载」。';
            }
          );
        } else {
          noteEl.textContent = '当前环境不支持剪贴板，请用「下载」。';
        }
        return;
      }
      if (act === 'download') {
        var blob = new Blob([full], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'ice-chart-snapshot.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () {
          URL.revokeObjectURL(url);
        }, 1000);
      }
    });

    // 快照会随「数据域 / 显隐」变化：在这些语义事件之后刷新
    entries.forEach(function (entry) {
      ['zoom:change', 'pan:change', 'legend:toggle', 'data:change'].forEach(function (eventName) {
        entry.chart.on(eventName, scheduleRefresh);
      });
    });

    global.__snapshotPanel = {
      refresh: refresh,
      get full() {
        return full;
      },
      get snapshot() {
        return JSON.parse(full);
      },
      resize: refresh,
    };
    refresh();
    return global.__snapshotPanel;
  }

  global.mountSnapshotPanel = mount;
})(window);
