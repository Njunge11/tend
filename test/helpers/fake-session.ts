import type { SessionRequest, SessionResult, SessionRunner } from "../../src/session/types.js";

type FakeSession = SessionRunner & { calls: SessionRequest[] };

type Responder = (req: SessionRequest) => SessionResult | Promise<SessionResult>;

/**
 * Scripted SessionRunner for tests. Pass a fixed result, or a responder function
 * (e.g. to vary the reply per file). Records every request in `.calls`.
 */
export function fakeSession(responder: SessionResult | Responder): FakeSession {
  const fn: Responder = typeof responder === "function" ? responder : () => responder;
  const calls: SessionRequest[] = [];
  return {
    calls,
    async run(request) {
      calls.push(request);
      return fn(request);
    },
  };
}
