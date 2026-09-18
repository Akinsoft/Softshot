export function rejectedReasons(results: ReadonlyArray<PromiseSettledResult<unknown>>): unknown[] {
  const reasons: unknown[] = [];
  for (const result of results) {
    if (result.status === "rejected") {
      reasons.push(result.reason as unknown);
    }
  }

  return reasons;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function combinedError(message: string, errors: readonly unknown[]): AggregateError {
  return new AggregateError(errors, `${message}\n${errors.map((error) => errorMessage(error)).join("\n")}`);
}

export function throwCollectedErrors(errors: readonly unknown[], message: string): void {
  if (errors.length > 0) {
    throw combinedError(message, errors);
  }
}
