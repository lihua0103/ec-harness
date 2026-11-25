/** 粗排文字宽度（用于下划线长度与行内第二段起点，误差在 1-2px）。 */
export function estimateTextWidth(text: string, size: number, weight = 400): number {
  let units = 0;
  for (const char of text) {
    if (/[　-鿿＀-￯]/.test(char)) units += 1;
    else if (/[il.,:;'!|]/.test(char)) units += 0.28;
    else if (/[A-Z0-9%·]/.test(char)) units += 0.6;
    else units += 0.53;
  }
  return units * size * (weight >= 600 ? 1.04 : 1);
}
