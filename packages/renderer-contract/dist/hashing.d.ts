import type { RenderCommandBuffer, Sha256Hex, ViewModel } from './types.js';
export declare function canonicalizeForHash(value: unknown): string;
export declare function canonicalEncodeForHash(value: unknown): Uint8Array;
export declare function sha256Hex(bytes: Uint8Array): Promise<Sha256Hex>;
export declare function hashViewModel(viewModel: ViewModel): Promise<Sha256Hex>;
export declare function hashRenderCommandBuffer(rcb: RenderCommandBuffer): Promise<Sha256Hex>;
declare function normalizeNumbersForHash(value: unknown): unknown;
export { normalizeNumbersForHash };
//# sourceMappingURL=hashing.d.ts.map