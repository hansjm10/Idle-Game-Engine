export declare const RENDERER_CONTRACT_SCHEMA_VERSION: 3;
export type RendererContractSchemaVersion = typeof RENDERER_CONTRACT_SCHEMA_VERSION;
export type Sha256Hex = string;
export type AssetId = string & {
    readonly __brand: 'AssetId';
};
export type AssetKind = 'image' | 'font' | 'spriteSheet' | 'shader';
export interface AssetManifestEntry {
    readonly id: AssetId;
    readonly kind: AssetKind;
    readonly contentHash: Sha256Hex;
}
export interface AssetManifest {
    readonly schemaVersion: RendererContractSchemaVersion;
    readonly assets: readonly AssetManifestEntry[];
}
export interface FrameHeader {
    readonly schemaVersion: RendererContractSchemaVersion;
    readonly step: number;
    readonly simTimeMs: number;
    readonly renderFrame?: number;
    readonly contentHash: Sha256Hex;
}
export interface Camera2D {
    readonly x: number;
    readonly y: number;
    readonly zoom: number;
}
export interface SpriteInstance {
    readonly id: string;
    readonly assetId: AssetId;
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly width: number;
    readonly height: number;
    readonly tintRgba?: number;
}
export interface UiViewModel {
    readonly nodes: readonly UiNode[];
}
export interface UiBaseNode {
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}
export interface UiRectNode extends UiBaseNode {
    readonly kind: 'rect';
    readonly colorRgba: number;
    readonly radiusPx?: number;
}
export interface UiImageNode extends UiBaseNode {
    readonly kind: 'image';
    readonly assetId: AssetId;
    readonly tintRgba?: number;
}
export interface UiTextNode extends UiBaseNode {
    readonly kind: 'text';
    readonly text: string;
    readonly colorRgba: number;
    readonly fontAssetId?: AssetId;
    readonly fontSizePx: number;
}
export interface UiMeterNode extends UiBaseNode {
    readonly kind: 'meter';
    readonly value: number;
    readonly max: number;
    readonly fillColorRgba: number;
    readonly backgroundColorRgba: number;
}
export type UiNode = UiRectNode | UiImageNode | UiTextNode | UiMeterNode;
export interface ViewModel {
    readonly frame: FrameHeader;
    readonly scene: {
        readonly camera: Camera2D;
        readonly sprites: readonly SpriteInstance[];
    };
    readonly ui: UiViewModel;
}
export type RenderPassId = 'world' | 'ui';
export interface RenderPass {
    readonly id: RenderPassId;
}
export interface SortKey {
    readonly sortKeyHi: number;
    readonly sortKeyLo: number;
}
export interface ClearDraw {
    readonly kind: 'clear';
    readonly passId: RenderPassId;
    readonly sortKey: SortKey;
    readonly colorRgba: number;
}
export interface RectDraw {
    readonly kind: 'rect';
    readonly passId: RenderPassId;
    readonly sortKey: SortKey;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly colorRgba: number;
}
export interface ImageDraw {
    readonly kind: 'image';
    readonly passId: RenderPassId;
    readonly sortKey: SortKey;
    readonly assetId: AssetId;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly tintRgba?: number;
}
export interface TextDraw {
    readonly kind: 'text';
    readonly passId: RenderPassId;
    readonly sortKey: SortKey;
    readonly x: number;
    readonly y: number;
    readonly text: string;
    readonly colorRgba: number;
    readonly fontAssetId?: AssetId;
    readonly fontSizePx: number;
}
export interface ScissorPushDraw {
    readonly kind: 'scissorPush';
    readonly passId: RenderPassId;
    readonly sortKey: SortKey;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}
export interface ScissorPopDraw {
    readonly kind: 'scissorPop';
    readonly passId: RenderPassId;
    readonly sortKey: SortKey;
}
export type RenderDraw = ClearDraw | RectDraw | ImageDraw | TextDraw | ScissorPushDraw | ScissorPopDraw;
export interface RenderCommandBuffer {
    readonly frame: FrameHeader;
    readonly passes: readonly RenderPass[];
    readonly draws: readonly RenderDraw[];
}
//# sourceMappingURL=types.d.ts.map