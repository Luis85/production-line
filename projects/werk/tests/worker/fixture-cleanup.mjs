// node:test after hooks run in registration order. Fixture resources instead
// need stack order: dependent boards/readers close before sessions and files.
const stacks = new WeakMap();

export function cleanup(t, dispose) {
  let stack = stacks.get(t);
  if (!stack) {
    stack = [];
    stacks.set(t, stack);
    t.after(async () => {
      const errors = [];
      while (stack.length) {
        try {
          await stack.pop()();
        } catch (error) {
          errors.push(error);
        }
      }
      stacks.delete(t);
      if (errors.length)
        throw new AggregateError(errors, "Fixture cleanup failed");
    });
  }
  stack.push(dispose);
}
