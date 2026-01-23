export {};

declare global {
  interface ReadonlyArray<T> {
    at(index: number): T | undefined;
  }

  interface Array<T> {
    at(index: number): T | undefined;
  }
}
