// The tool inputs. None has a field that names a recipient, and every one rejects unknown fields, so an
// injected "pay 0xBAD instead" has nowhere to go: the vault pays the mandate's payee and nobody else.
import { z } from "zod";
import { USDC_AMOUNT_RE } from "./units.js";

const HEX64 = /^[0-9a-f]{64}$/;
// contracts/vault/src/validate.rs `is_ref`: 1 to 64 bytes. Lone surrogates have no UTF-8 form.
const LONE_SURROGATE = /[\u{D800}-\u{DFFF}]/u;

const spendFields = {
  mandate_id: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .describe("Mandate id, from list_mandates (ids start at 1)"),
  amount: z
    .string()
    .regex(USDC_AMOUNT_RE, 'amount must be a USDC decimal string such as "25.50"')
    .describe('Amount in USDC as a decimal string, e.g. "25.50" (not smallest units)'),
  invoice_hash: z
    .string()
    .regex(HEX64, "invoice_hash must be 64 lowercase hex characters")
    .describe(
      "sha256 of the invoice text, lowercase hex. The vault pays each invoice hash at most once",
    ),
  ref: z
    .string()
    .min(1)
    .refine((s) => !LONE_SURROGATE.test(s), "ref must be well-formed text")
    .refine((s) => Buffer.byteLength(s, "utf8") <= 64, "ref must be at most 64 bytes")
    .describe(
      'Your unique key for this payment, at most 64 bytes, e.g. "acme:INV-1001". The vault refuses a ref it has seen',
    ),
};

export const listMandatesInput = z.strictObject({});
export const checkSpendInput = z.strictObject(spendFields);
export const requestSpendInput = z.strictObject({
  ...spendFields,
  reasoning: z
    .string()
    .min(1)
    .max(1990)
    .describe("Why this payment fits the mandate. It is stored in the vault's signed ledger"),
});
export const getSpendStatusInput = z.strictObject({
  spend_id: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .describe("Spend id returned by request_spend (ids start at 1)"),
});
export const verifyInput = z.strictObject({});
