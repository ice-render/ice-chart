/**
 * 给颜色压上透明度。
 *
 * 支持 `#rgb` / `#rrggbb` / `rgb(...)`；其它写法（`rgba()`、`hsl()`、主题变量、
 * 渐变对象名……）原样返回 —— 拼一个不认识的字符串只会得到非法的 canvas 颜色，
 * 那比「不压透明度」更糟。
 */
export function withAlpha(color: string, alpha: number): string {
  if (typeof color !== 'string') return `rgba(0,0,0,${alpha})`;
  if (color.charAt(0) === '#') {
    let hex = color.slice(1);
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    if (hex.length !== 6) return color;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  if (color.indexOf('rgb(') === 0) return color.replace('rgb(', 'rgba(').replace(')', `,${alpha})`);
  return color;
}
