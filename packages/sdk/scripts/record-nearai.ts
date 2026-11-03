// OWNER-RUN ONLY. Calls NEAR AI Cloud with the owner's NEARAI_API_KEY and records one real attested
// decision for offline tests. It spends a few tokens. The API key is read from the environment, is only
// ever sent as the Authorization header, and is never printed or written to disk.
//
//   NEARAI_API_KEY=<owner key> pnpm --filter @probarion/sdk run record:nearai
//
// It also prints what the real service does where the code had to guess (the signed text format, the
// signature's v and s), so the one constant PROVIDER_TEE_TEXT_FORMAT and the normalizer can be settled.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AttestationEvidence,
  checkAttestation,
  checkRequestBinding,
  computeNonce,
  type InvoiceFacts,
  type MandateView,
  NEARAI_BASE_URL,
  type NonceContext,
  PROVIDER_TEE_TEXT_FORMAT,
  parseTdxQuote,
  sha256Hex,
  ZERO_LINK,
} from "@probarion/core";
import { envValue } from "../src/env.js";
import { NearAiProposer, redactSecrets } from "../src/nearai.js";

const apiKey = envValue(process.env, "NEARAI_API_KEY");
if (apiKey === undefined) {
  process.stderr.write("NEARAI_API_KEY is not set. This script is run by the OWNER only.\n");
  process.exit(2);
}

/** A vault id the factory refuses (a one-character label), so this recording can never be a real vault's. */
const FIXTURE_VAULT = "x.vaults.probarion.testnet";
const invoiceText = [
  "RECORDING FIXTURE (synthetic invoice, no real vendor)",
  "Invoice INV-REC-1 from Vendor Ltd, NEAR account vendor.testnet",
  "Reference: PO-1001 monthly design retainer",
  "Total due: 25.00 USDC",
].join("\n");
const purpose = sha256Hex("RECORDING FIXTURE PO-1001");
const mandate: MandateView = {
  id: 1,
  payee: { type: "near", account_id: "vendor.testnet" },
  purpose_hash: purpose,
  max_per_payment: "100000000",
  max_total: "1000000000",
  spent: "0",
  reserved: "0",
  max_uses: 10,
  uses: 0,
  expires_at_ns: "1798761600000000000",
  approval_above: "50000000",
  agent_pk: "ed25519:11111111111111111111111111111111",
  label: "Recording fixture",
  status: "active",
  created_at_ns: "1793750400000000000",
};
const facts: InvoiceFacts = {
  invoice_hash: sha256Hex(invoiceText),
  amount: "25000000",
  po_ref: "PO-1001",
  purpose_hash: purpose,
  payee_hint: { near_account: "vendor.testnet" },
};
const context: NonceContext = {
  vault: FIXTURE_VAULT,
  prev_link: ZERO_LINK,
  invoice_hash: facts.invoice_hash,
  mandate_id: 1,
  seq: 0,
};
const nonce = computeNonce(context);

const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** Everything the script prints goes through this, so a credential that an error or a response echoes never reaches the terminal. */
const clean = (text: string): string => redactSecrets(text, [apiKey]);

/** The signed text with this decision's values put back as placeholders: the format string to put in core. */
function describeSignedText(evidence: AttestationEvidence): string {
  return evidence.signature.text
    .replaceAll(evidence.request_sha256, "{request_sha256}")
    .replaceAll(evidence.response_sha256, "{response_sha256}")
    .replaceAll(evidence.model, "{model}");
}

/** The provider's own encoding of the signature, which the SDK normalizes before storing. No secret is read. */
async function probeRawSignature(
  chatId: string,
  model: string,
): Promise<{ v: string | null; highS: boolean | null }> {
  const url = new URL(`${NEARAI_BASE_URL}/signature/${encodeURIComponent(chatId)}`);
  url.searchParams.set("model", model);
  url.searchParams.set("signing_algo", "ecdsa");
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    });
    const body: unknown = await res.json();
    const raw =
      typeof body === "object" && body !== null && "signature" in body
        ? String(body.signature)
        : "";
    const hex = raw.replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{130}$/.test(hex)) return { v: null, highS: null };
    return { v: hex.slice(128), highS: BigInt(`0x${hex.slice(64, 128)}`) > SECP256K1_HALF_N };
  } catch {
    return { v: null, highS: null };
  }
}

try {
  const proposer = new NearAiProposer({ apiKey, model: envValue(process.env, "NEARAI_MODEL") });
  const { proposal, evidence } = await proposer.propose({
    invoiceText,
    facts,
    mandates: [mandate],
    nonce,
  });
  const offline = await checkAttestation(evidence, nonce, proposal);
  const a8 = checkRequestBinding(evidence, invoiceText, context);
  const quote = evidence.report === null ? null : parseTdxQuote(evidence.report.intel_quote);
  const rawSignature = await probeRawSignature(evidence.chat_id, evidence.model);
  const signedText = describeSignedText(evidence);

  const recordedJson = `${JSON.stringify(
    {
      note: "Recorded from NEAR AI Cloud by the OWNER. Real attestation evidence; the invoice is synthetic test data.",
      recorded_at: new Date().toISOString(),
      context,
      invoice_text: invoiceText,
      proposal,
      evidence,
      quote_version: quote?.version ?? null,
      signed_text_format: signedText,
      raw_signature: rawSignature,
      offline_check: offline,
      request_binding_check: a8,
    },
    null,
    2,
  )}\n`;
  if (recordedJson.includes(apiKey)) {
    throw new Error("the API key appears in the recording; refusing to write it");
  }
  const out = new URL("../test/fixtures/nearai-recorded/decision.json", import.meta.url);
  await mkdir(dirname(fileURLToPath(out)), { recursive: true });
  await writeFile(out, recordedJson);

  const failed = offline.checks.filter((c) => !c.pass);
  const summary = [
    `recorded ${evidence.model} chat ${evidence.chat_id}; quote v${quote?.version ?? "?"}; offline A1-A7: ${
      offline.ok ? "PASS" : `FAIL ${failed.map((c) => `${c.id}: ${c.detail}`).join("; ")}`
    }; A8: ${a8.pass ? "PASS" : `FAIL ${a8.detail}`}`,
    `size: the recording is ${recordedJson.length} bytes; response_body ${evidence.response_body.length} chars`,
    `signed text format seen: ${signedText}`,
    `signed text format in core (PROVIDER_TEE_TEXT_FORMAT): ${PROVIDER_TEE_TEXT_FORMAT}${
      signedText === PROVIDER_TEE_TEXT_FORMAT ? " (same)" : " (DIFFERENT: change that one constant)"
    }`,
    `provider signature encoding before normalization: v=${rawSignature.v ?? "unknown"}, ${
      rawSignature.highS === null ? "s unknown" : rawSignature.highS ? "high-s" : "low-s"
    }`,
    `wrote ${fileURLToPath(out)}`,
    "",
  ].join("\n");
  process.stdout.write(clean(summary));
  if (!offline.ok || !a8.pass) process.exitCode = 1;
} catch (error) {
  // NearAiError messages are already redacted; clean() is the second, independent line of defence.
  process.stderr.write(
    clean(`recording failed: ${error instanceof Error ? error.message : String(error)}\n`),
  );
  process.exitCode = 1;
}
