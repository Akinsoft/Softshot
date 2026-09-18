import { errorMessage } from "./async-errors.js";
import type { SoftshotApi } from "./shared.js";

type SoftshotGlobal = typeof globalThis & {
  softshot: SoftshotApi;
};

export function getSoftshotApi(): SoftshotApi {
  return (globalThis as SoftshotGlobal).softshot;
}

export async function reportError(message: string, error: unknown): Promise<void> {
  await getSoftshotApi().showError(`${message}\n\n${errorMessage(error)}`);
}

export async function reportAsyncError(task: Promise<void>, message: string): Promise<void> {
  try {
    await task;
  } catch (error) {
    await reportError(message, error);
  }
}
