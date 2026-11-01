// TEST FIXTURE keys. Derived from fixed public strings: they protect nothing and must never hold funds.
import { privateKeyToAccount } from "viem/accounts";
import { sha256Bytes, sha256Hex } from "../../src/hash.js";
import { utf8 } from "../../src/hex.js";
import { generateKeyPair } from "../../src/keys.js";

export const TEST_LEDGER_KEY = generateKeyPair(
  sha256Bytes(utf8("probarion/test-fixture/ledger-key")),
);
export const TEST_AGENT_KEY = generateKeyPair(
  sha256Bytes(utf8("probarion/test-fixture/agent-key")),
);
export const TEST_FORGED_KEY = generateKeyPair(
  sha256Bytes(utf8("probarion/test-fixture/forged-key")),
);
/** The ledger key after a set_ledger_key rotation (rotation fixtures only). */
export const TEST_ROTATED_KEY = generateKeyPair(
  sha256Bytes(utf8("probarion/test-fixture/rotated-ledger-key")),
);

/** Local secp256k1 key standing in for a TEE signing key, so A1–A6 run offline. Not a NEAR AI key. */
export const TEST_TEE_PRIVATE_KEY: `0x${string}` = `0x${sha256Hex("probarion/test-fixture/tee-secp256k1-key")}`;
export const TEST_OTHER_TEE_PRIVATE_KEY: `0x${string}` = `0x${sha256Hex("probarion/test-fixture/other-tee-key")}`;
export const TEST_TEE_ADDRESS = privateKeyToAccount(TEST_TEE_PRIVATE_KEY).address;
