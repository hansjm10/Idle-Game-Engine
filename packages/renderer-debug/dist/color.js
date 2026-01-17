export function rgbaToCssColor(rgba) {
    const u32 = rgba >>> 0;
    const r = (u32 >>> 24) & 0xff;
    const g = (u32 >>> 16) & 0xff;
    const b = (u32 >>> 8) & 0xff;
    const a = u32 & 0xff;
    const alpha = a / 255;
    const alphaText = alpha === 1
        ? '1'
        : alpha.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    return `rgba(${r}, ${g}, ${b}, ${alphaText})`;
}
//# sourceMappingURL=color.js.map