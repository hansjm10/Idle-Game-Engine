export {};

declare global {
  interface ObjectConstructor {
    hasOwn(object: object, key: PropertyKey): boolean;
  }
}
