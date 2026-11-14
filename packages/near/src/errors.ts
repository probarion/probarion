// Shared error type (S0, integrator-owned). Network and JSON-RPC failures are NearRpcError (rpc.ts).

/**
 * A value is not in the shape NEAR gives it: a hash that is not 32 canonical base58 bytes, a number where a
 * decimal string belongs, an RPC answer without `result`. `what` names the value (for example
 * `"outcome_proof.block_hash"`), so a caller can tell which input was refused without parsing the message.
 */
export class NearFormatError extends Error {
  override readonly name = "NearFormatError";
  constructor(
    readonly what: string,
    message: string,
  ) {
    super(message);
  }
}
