// A scripted NearRpc for unit tests: `answer` gets each call and returns (or resolves to) its result; a throw or a
// rejection in `answer` rejects the call. Every call is recorded in `calls`, in order, so a test can check the exact
// methods and params a helper sent.
import type { NearRpc } from "../../src/rpc.js";

export interface FakeRpcCall {
  method: string;
  params: unknown;
}

export function fakeRpc(
  answer: (method: string, params: unknown) => unknown | Promise<unknown>,
): NearRpc & { calls: FakeRpcCall[] } {
  const calls: FakeRpcCall[] = [];
  return {
    calls,
    async call<T = unknown>(method: string, params: unknown): Promise<T> {
      calls.push({ method, params });
      return (await answer(method, params)) as T;
    },
  };
}
