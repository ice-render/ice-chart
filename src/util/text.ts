/**
 * 文本测量与排版。优先用真实 ctx.measureText，拿不到时退化为估算
 * —— 单测里也可能没有可用的 2d 上下文。
 */

export interface TextMetricsLike {
  width: number;
}

export function measureTextWidth(ctx: any, text: string, fontSize: number, fontFamily: string): number {
  if (!text) return 0;
  if (ctx && typeof ctx.measureText === 'function') {
    try {
      const prevFont = ctx.font;
      ctx.font = `${fontSize}px ${fontFamily}`;
      const metrics = ctx.measureText(text);
      ctx.font = prevFont;
      if (metrics && typeof metrics.width === 'number' && isFinite(metrics.width)) {
        return metrics.width;
      }
    } catch (err) {
      // 忽略：退化为估算
    }
  }
  // 估算：拉丁字符按 0.55em，CJK 按 1em（中日韩文字宽度约等于字号）
  let width = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    width += code > 0x2e80 ? 1 : 0.55;
  }
  return width * fontSize;
}

/** 按最大宽度折行（按空格切分，超长单词硬切）。 */
export function wrapText(text: string, maxWidth: number, charWidth: number): string[] {
  const lines: string[] = [];
  const rawLines = String(text).split('\n');
  for (const raw of rawLines) {
    if (maxWidth <= 0 || charWidth <= 0) {
      lines.push(raw);
      continue;
    }
    const maxChars = Math.max(1, Math.floor(maxWidth / charWidth));
    if (raw.length <= maxChars) {
      lines.push(raw);
      continue;
    }
    let rest = raw;
    while (rest.length > maxChars) {
      let cut = rest.lastIndexOf(' ', maxChars);
      if (cut <= 0) cut = maxChars;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^\s+/, '');
    }
    if (rest) lines.push(rest);
  }
  return lines;
}
