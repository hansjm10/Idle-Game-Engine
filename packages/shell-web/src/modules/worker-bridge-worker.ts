export interface WorkerBridgeWorker {
  addEventListener(
    type: string,
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  postMessage(message: unknown): void;
  terminate(): void;
}
