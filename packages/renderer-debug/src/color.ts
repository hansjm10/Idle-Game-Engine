export function rgbaToCssColor(rgba: number): string {
  const u32 = rgba >>> 0;
  const r = (u32 >>> 24) & 0xff;
  const g = (u32 >>> 16) & 0xff;
  const b = (u32 >>> 8) & 0xff;
  const a = u32 & 0xff;

  const alpha = a / 255;
  let alphaText: string;
  if (alpha === 1) {
    alphaText = '1';
  } else {
    alphaText = alpha.toFixed(3);
    while (alphaText.endsWith('0')) {
      alphaText = alphaText.slice(0, -1);
    }
    if (alphaText.endsWith('.')) {
      alphaText = alphaText.slice(0, -1);
    }
  }

  return `rgba(${r}, ${g}, ${b}, ${alphaText})`;
}
