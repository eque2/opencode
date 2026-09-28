// @parcel/watcher publishes wrapper.js without a declaration. createWrapper builds the
// package API around a native binding that the caller loads itself.
declare module "@parcel/watcher/wrapper" {
  export function createWrapper(binding: unknown): typeof import("@parcel/watcher")
}
