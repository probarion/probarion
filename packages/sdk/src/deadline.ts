// The time a caller has left (`remainingMs` on RpcClient and NearAiProposer): the one floor below which no call starts.

/**
 * A call is not started when the caller's time left is below this many milliseconds: no network request finishes in
 * less, and a timer can fire a little before `Date.now()` reaches the deadline, so a call sent with what is left would
 * only time out. A NEAR AI signature back-off that would leave less than this for the try after it is not waited out
 * either; RpcClient cuts its back-off to what is left instead.
 */
export const MIN_CALL_MS = 50;
