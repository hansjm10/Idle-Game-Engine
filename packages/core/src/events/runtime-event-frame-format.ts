import { telemetry } from '../telemetry.js';

export type RuntimeEventFrameFormat = 'struct-of-arrays' | 'object-array';

export interface RuntimeEventFrameDiagnostics {
  readonly windowLength: number;
  readonly samples: number;
  readonly averageEventsPerChannel: number;
  readonly densityThreshold: number;
  readonly featureFlagEnabled: boolean;
}

export interface EventFrameFormatChange {
  readonly previousFormat: RuntimeEventFrameFormat;
  readonly nextFormat: RuntimeEventFrameFormat;
  readonly diagnostics: RuntimeEventFrameDiagnostics;
}

export interface RuntimeEventFrameExportState {
  readonly format: RuntimeEventFrameFormat;
  readonly diagnostics: RuntimeEventFrameDiagnostics;
}

export interface RuntimeEventFrameAutoFallbackOptions {
  readonly enabled: boolean;
  readonly windowLength?: number;
  readonly densityThreshold?: number;
}

export interface RuntimeEventFrameExportOptions {
  readonly defaultFormat?: RuntimeEventFrameFormat;
  readonly autoFallback?: RuntimeEventFrameAutoFallbackOptions;
}

const DEFAULT_WINDOW_LENGTH = 256;
const DEFAULT_DENSITY_THRESHOLD = 2;

export class RuntimeEventFrameFormatController {
  private readonly history: number[];
  private readonly windowLength: number;
  private readonly densityThreshold: number;
  private readonly channelCount: number;
  private readonly featureFlagEnabled: boolean;

  private historyIndex = 0;
  private historySize = 0;
  private runningTotal = 0;
  private currentFormat: RuntimeEventFrameFormat;

  constructor(channelCount: number, options: RuntimeEventFrameExportOptions = {}) {
    if (!Number.isFinite(channelCount) || channelCount <= 0) {
      throw new Error(
        `RuntimeEventFrameFormatController requires a positive channel count (received ${channelCount}).`,
      );
    }

    const defaultFormat = options.defaultFormat ?? 'struct-of-arrays';
    const fallbackOptions = options.autoFallback ?? { enabled: false };
    const windowLength = fallbackOptions.windowLength ?? DEFAULT_WINDOW_LENGTH;
    const densityThreshold = fallbackOptions.densityThreshold ?? DEFAULT_DENSITY_THRESHOLD;

    if (!Number.isFinite(windowLength) || windowLength <= 0) {
      throw new Error(
        `RuntimeEventFrameFormatController window length must be a positive number (received ${windowLength}).`,
      );
    }

    if (!Number.isFinite(densityThreshold) || densityThreshold < 0) {
      throw new Error(
        `RuntimeEventFrameFormatController density threshold must be non-negative (received ${densityThreshold}).`,
      );
    }

    this.channelCount = channelCount;
    this.currentFormat = defaultFormat;
    this.featureFlagEnabled = fallbackOptions.enabled === true;
    this.windowLength = Math.floor(windowLength);
    this.densityThreshold = densityThreshold;
    this.history = new Array(this.windowLength).fill(0);
  }

  beginTick(previousTickEvents: number, tick: number): EventFrameFormatChange | null {
    if (!Number.isFinite(previousTickEvents) || previousTickEvents < 0) {
      throw new Error(
        `RuntimeEventFrameFormatController cannot record negative events for a tick (received ${previousTickEvents}).`,
      );
    }

    if (!this.featureFlagEnabled) {
      this.recordSample(previousTickEvents);
      return null;
    }

    const previousFormat = this.currentFormat;
    this.recordSample(previousTickEvents);
    const diagnostics = this.getDiagnostics();
    const shouldFallback =
      diagnostics.averageEventsPerChannel < this.densityThreshold;

    this.currentFormat = shouldFallback ? 'object-array' : 'struct-of-arrays';

    if (this.currentFormat === previousFormat) {
      return null;
    }

    telemetry.recordWarning('RuntimeEventFrameFormatChanged', {
      tick,
      previousFormat,
      nextFormat: this.currentFormat,
      averageEventsPerChannel: diagnostics.averageEventsPerChannel,
      densityThreshold: diagnostics.densityThreshold,
      windowLength: diagnostics.windowLength,
      samples: diagnostics.samples,
      featureFlagEnabled: diagnostics.featureFlagEnabled,
    });

    return {
      previousFormat,
      nextFormat: this.currentFormat,
      diagnostics,
    };
  }

  getExportState(): RuntimeEventFrameExportState {
    return {
      format: this.currentFormat,
      diagnostics: this.getDiagnostics(),
    };
  }

  private recordSample(previousTickEvents: number): void {
    const averagePerChannel =
      this.channelCount === 0 ? 0 : previousTickEvents / this.channelCount;

    if (this.historySize === this.windowLength) {
      const previous = this.history[this.historyIndex];
      this.runningTotal -= previous;
    } else {
      this.historySize += 1;
    }

    this.history[this.historyIndex] = averagePerChannel;
    this.runningTotal += averagePerChannel;
    this.historyIndex = (this.historyIndex + 1) % this.windowLength;
  }

  private getDiagnostics(): RuntimeEventFrameDiagnostics {
    const samples = this.historySize;
    const average =
      samples === 0 ? 0 : this.runningTotal / samples;

    return {
      windowLength: this.windowLength,
      samples,
      averageEventsPerChannel: average,
      densityThreshold: this.densityThreshold,
      featureFlagEnabled: this.featureFlagEnabled,
    };
  }
}
