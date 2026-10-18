/** Runs work for the same key one after another; different keys run independently. */
export class KeyedLock<K> {
  private readonly tails = new Map<K, Promise<void>>();

  run<T>(key: K, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(work);
    // The stored tail never rejects; the caller still sees the real outcome through `next`.
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
