/**
 * `read`, or a rejection after `ms`. A throw before the first promise is a rejection too. The timer never outlives the
 * read: it is cleared whichever way the read ends. The pages that read the database on the server (the Canary's board,
 * the usage numbers) use it so that a hung database cannot hold a visitor for long.
 */
export function within<T>(read: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    Promise.resolve()
      .then(read)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}
