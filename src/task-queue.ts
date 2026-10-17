export class TaskQueue {
  private tail: Promise<boolean> = Promise.resolve(true);

  async run<T>(task: () => Promise<T>): Promise<T> {
    const previousTask = this.tail;
    const { promise, resolve } = Promise.withResolvers<boolean>();
    this.tail = promise;
    await previousTask;
    try {
      return await task();
    } finally {
      resolve(true);
    }
  }
}
