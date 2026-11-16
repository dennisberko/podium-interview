/** Thrown from the `default` of an exhaustive `switch`; `value` must be `never`. */
export class UnreachableCaseError extends Error {
  constructor(value: never) {
    super(`unreachable case: ${JSON.stringify(value)}`);
    this.name = "UnreachableCaseError";
  }
}
