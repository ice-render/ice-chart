import type { Scale } from './Scale';
import type { CreateScaleOptions } from './Scale';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

type TimeUnit = 'ms' | 's' | 'm' | 'h' | 'd' | 'mo' | 'y';

interface Interval {
  unit: TimeUnit;
  /** 该间隔对应的近似毫秒数，用来按数据跨度挑间隔。 */
  ms: number;
  floor: (t: number) => number;
  next: (t: number) => number;
}

function makeInterval(
  unit: TimeUnit,
  step: number,
  unitMs: number,
  floorDate: (d: Date) => void,
  nextDate: (d: Date) => void
): Interval {
  return {
    unit,
    ms: step * unitMs,
    floor: (t: number) => {
      const d = new Date(t);
      floorDate(d);
      return d.getTime();
    },
    next: (t: number) => {
      const d = new Date(t);
      nextDate(d);
      return d.getTime();
    },
  };
}

/** 从毫秒到年的固定时间间隔表，按步长升序。 */
const INTERVALS: Interval[] = [
  makeInterval('ms', 1, 1, () => undefined, (d) => d.setUTCMilliseconds(d.getUTCMilliseconds() + 1)),
  makeInterval('ms', 10, 1, (d) => d.setUTCMilliseconds(Math.floor(d.getUTCMilliseconds() / 10) * 10), (d) => d.setUTCMilliseconds(d.getUTCMilliseconds() + 10)),
  makeInterval('ms', 100, 1, (d) => d.setUTCMilliseconds(Math.floor(d.getUTCMilliseconds() / 100) * 100), (d) => d.setUTCMilliseconds(d.getUTCMilliseconds() + 100)),
  makeInterval('s', 1, SECOND, (d) => d.setUTCMilliseconds(0), (d) => d.setUTCSeconds(d.getUTCSeconds() + 1)),
  makeInterval('s', 5, SECOND, (d) => d.setUTCSeconds(Math.floor(d.getUTCSeconds() / 5) * 5, 0), (d) => d.setUTCSeconds(d.getUTCSeconds() + 5)),
  makeInterval('s', 15, SECOND, (d) => d.setUTCSeconds(Math.floor(d.getUTCSeconds() / 15) * 15, 0), (d) => d.setUTCSeconds(d.getUTCSeconds() + 15)),
  makeInterval('s', 30, SECOND, (d) => d.setUTCSeconds(Math.floor(d.getUTCSeconds() / 30) * 30, 0), (d) => d.setUTCSeconds(d.getUTCSeconds() + 30)),
  makeInterval('m', 1, MINUTE, (d) => d.setUTCSeconds(0, 0), (d) => d.setUTCMinutes(d.getUTCMinutes() + 1)),
  makeInterval('m', 5, MINUTE, (d) => d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 5) * 5, 0, 0), (d) => d.setUTCMinutes(d.getUTCMinutes() + 5)),
  makeInterval('m', 15, MINUTE, (d) => d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 15) * 15, 0, 0), (d) => d.setUTCMinutes(d.getUTCMinutes() + 15)),
  makeInterval('m', 30, MINUTE, (d) => d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 30) * 30, 0, 0), (d) => d.setUTCMinutes(d.getUTCMinutes() + 30)),
  makeInterval('h', 1, HOUR, (d) => d.setUTCMinutes(0, 0, 0), (d) => d.setUTCHours(d.getUTCHours() + 1)),
  makeInterval('h', 3, HOUR, (d) => d.setUTCHours(Math.floor(d.getUTCHours() / 3) * 3, 0, 0, 0), (d) => d.setUTCHours(d.getUTCHours() + 3)),
  makeInterval('h', 6, HOUR, (d) => d.setUTCHours(Math.floor(d.getUTCHours() / 6) * 6, 0, 0, 0), (d) => d.setUTCHours(d.getUTCHours() + 6)),
  makeInterval('h', 12, HOUR, (d) => d.setUTCHours(Math.floor(d.getUTCHours() / 12) * 12, 0, 0, 0), (d) => d.setUTCHours(d.getUTCHours() + 12)),
  makeInterval('d', 1, DAY, (d) => d.setUTCHours(0, 0, 0, 0), (d) => d.setUTCDate(d.getUTCDate() + 1)),
  makeInterval('d', 2, DAY, (d) => d.setUTCHours(0, 0, 0, 0), (d) => d.setUTCDate(d.getUTCDate() + 2)),
  makeInterval('d', 7, DAY, (d) => d.setUTCHours(0, 0, 0, 0), (d) => d.setUTCDate(d.getUTCDate() + 7)),
  makeInterval('mo', 1, MONTH, (d) => d.setUTCHours(0, 0, 0, 0), (d) => d.setUTCMonth(d.getUTCMonth() + 1)),
  makeInterval('mo', 3, MONTH, (d) => d.setUTCHours(0, 0, 0, 0), (d) => d.setUTCMonth(d.getUTCMonth() + 3)),
  makeInterval('y', 1, YEAR, (d) => d.setUTCHours(0, 0, 0, 0), (d) => d.setUTCFullYear(d.getUTCFullYear() + 1)),
];

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** 时间轴标签格式：粒度越粗，展示的单位越大。 */
export function formatTime(timestamp: number, unit: TimeUnit, span: number): string {
  const d = new Date(timestamp);
  const h = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const s = pad(d.getUTCSeconds());
  const mo = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const y = d.getUTCFullYear();
  const showYear = span > 3 * YEAR;
  switch (unit) {
    case 'ms':
      return `${h}:${mi}:${s}.${pad(d.getUTCMilliseconds())}`;
    case 's':
      return `${h}:${mi}:${s}`;
    case 'm':
      return `${h}:${mi}`;
    case 'h':
      return `${h}:00`;
    case 'd':
      return showYear ? `${y}-${mo}-${day}` : `${mo}-${day}`;
    case 'mo':
      return showYear ? `${y}-${mo}` : `${mo}-01`;
    default:
      return `${y}`;
  }
}

/** 时间比例尺：数据域用时间戳（number）表示。 */
export class TimeScale implements Scale {
  public readonly type = 'time' as const;
  public domain: [number, number];
  public range: [number, number];

  constructor(domain: [number, number], range: [number, number], _options: CreateScaleOptions = {}) {
    const d0 = Number(domain[0]);
    const d1 = Number(domain[1]);
    this.domain = d0 === d1 ? [d0 - DAY, d1 + DAY] : [Math.min(d0, d1), Math.max(d0, d1)];
    this.range = range;
  }

  public map(value: any): number {
    const t = toTimestamp(value);
    const [d0, d1] = this.domain;
    const [r0, r1] = this.range;
    return r0 + ((t - d0) / (d1 - d0)) * (r1 - r0);
  }

  public invert(pixel: number): number {
    const [d0, d1] = this.domain;
    const [r0, r1] = this.range;
    if (r1 === r0) return d0;
    return d0 + ((pixel - r0) / (r1 - r0)) * (d1 - d0);
  }

  private pickInterval(count: number): Interval {
    const target = (this.domain[1] - this.domain[0]) / Math.max(1, count);
    let best = INTERVALS[0];
    let bestScore = Infinity;
    for (let i = 0; i < INTERVALS.length; i++) {
      const score = Math.abs(Math.log(INTERVALS[i].ms / target));
      if (score < bestScore) {
        bestScore = score;
        best = INTERVALS[i];
      }
    }
    return best;
  }

  public ticks(count = 5): number[] {
    const interval = this.pickInterval(count);
    const out: number[] = [];
    let t = interval.floor(this.domain[0]);
    if (t < this.domain[0]) t = interval.next(t);
    for (let guard = 0; t <= this.domain[1] && guard < 1000; guard++) {
      out.push(t);
      const next = interval.next(t);
      if (next === t) break;
      t = next;
    }
    return out;
  }

  public bandwidth(): number {
    return 0;
  }

  public bandStart(value: any): number {
    return this.map(value);
  }

  public step(): number {
    return this.pickInterval(5).ms;
  }

  public isBand(): boolean {
    return false;
  }

  public indexAt(_pixel: number): number {
    return -1;
  }

  public fractionOf(value: any): number {
    const [d0, d1] = this.domain;
    return d1 === d0 ? 0 : (toTimestamp(value) - d0) / (d1 - d0);
  }

  public valueAtFraction(fraction: number): number {
    const [d0, d1] = this.domain;
    return d0 + fraction * (d1 - d0);
  }

  public span(): number {
    return this.domain[1] - this.domain[0];
  }

  public format(value: any, _index: number): string {
    return formatTime(toTimestamp(value), this.pickInterval(5).unit, this.span());
  }

  public clone(): TimeScale {
    return new TimeScale([this.domain[0], this.domain[1]], [this.range[0], this.range[1]]);
  }
}

export function toTimestamp(value: any): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (!isNaN(t)) return t;
  }
  const n = Number(value);
  return isFinite(n) ? n : NaN;
}
