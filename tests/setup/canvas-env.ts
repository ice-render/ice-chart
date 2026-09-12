/**
 * jsdom 环境下的 Canvas 2D 上下文桩。
 *
 * 目的：让 ice-render 的渲染管线在 Node 里跑起来，从而能用**真实的**
 * 命中测试 / 事件派发 / 脏矩形路径来测 ice-chart，而不是把引擎 mock 掉。
 * 这里只记录状态、不真正光栅化（像素级回归交给 examples + 浏览器）。
 */

function createGradientStub(): any {
  return { addColorStop() {} };
}

function createContext(canvas: any): any {
  const ctx: any = {
    canvas,
    // 状态栈
    save() {},
    restore() {},
    setTransform() {},
    resetTransform() {},
    transform() {},
    translate() {},
    scale() {},
    rotate() {},
    // 路径
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    bezierCurveTo() {},
    quadraticCurveTo() {},
    arc() {},
    arcTo() {},
    ellipse() {},
    rect() {},
    clip() {},
    // 落墨
    fill() {},
    stroke() {},
    fillRect() {},
    strokeRect() {},
    clearRect() {},
    fillText() {},
    strokeText() {},
    drawImage() {},
    // 量测与图像
    measureText(text: string) {
      return { width: String(text === undefined ? '' : text).length * 6 };
    },
    createLinearGradient: createGradientStub,
    createRadialGradient: createGradientStub,
    createConicGradient: createGradientStub,
    createPattern() {
      return null;
    },
    getImageData() {
      return { data: new Uint8ClampedArray(4), width: 1, height: 1 };
    },
    putImageData() {},
    createImageData() {
      return { data: new Uint8ClampedArray(4), width: 1, height: 1 };
    },
    setLineDash() {},
    getLineDash() {
      return [];
    },
    // 状态属性
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 10,
    lineDashOffset: 0,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    shadowColor: 'transparent',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
  };
  return ctx;
}

const contextMap = new WeakMap<object, any>();

// jsdom 的 window.crypto 没有 randomUUID（ice-render 用 root.crypto.randomUUID 生成组件 id）
const globalScope: any = typeof window !== 'undefined' ? window : global;
const cryptoStub: any = globalScope.crypto || {};
if (typeof cryptoStub.randomUUID !== 'function') {
  cryptoStub.randomUUID = () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  };
}
if (globalScope.crypto !== cryptoStub) {
  try {
    Object.defineProperty(globalScope, 'crypto', { value: cryptoStub, configurable: true, writable: true });
  } catch (err) {
    // 忽略：某些环境的 crypto 是只读 getter，但通常已自带 randomUUID
  }
}

const canvasProto: any = typeof HTMLCanvasElement !== 'undefined' ? HTMLCanvasElement.prototype : null;
if (canvasProto) {
  canvasProto.getContext = function getContext(this: any, type: string) {
    if (type !== '2d') return null;
    let ctx = contextMap.get(this);
    if (!ctx) {
      ctx = createContext(this);
      contextMap.set(this, ctx);
    }
    return ctx;
  };
}

// 让 jsdom 里的 canvas 有个像样的内容盒尺寸（默认 getBoundingClientRect 全为 0）
if (canvasProto && typeof canvasProto.getBoundingClientRect === 'function') {
  canvasProto.getBoundingClientRect = function getBoundingClientRect(this: any) {
    const width = this.width || 300;
    const height = this.height || 150;
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON() {
        return {};
      },
    };
  };
}

export {};

/**
 * 测试统一跑「瞬时动效」：动画直接落到终态。
 *
 * 图表默认会播入场动画（这是产品行为），但单测断言的是几何与命中，
 * 需要在 `await chart.render()` 之后拿到稳定状态。全局设成 instant 既让断言确定，
 * 也避免每个用例都要等 500ms 的动画 —— 动画本身另有专门的时序用例覆盖。
 */
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const chartModule = require('../../src/index');
  if (chartModule && typeof chartModule.setMotionPreference === 'function') {
    chartModule.setMotionPreference('instant');
  }
} catch (err) {
  // 忽略：极少数用例可能先加载了别的模块
}
