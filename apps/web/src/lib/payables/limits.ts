/**
 * The largest invoice file read, and the largest purpose document the invoices route takes with it. The route caps
 * the whole request at this plus 64 KiB for the form, which stays under Vercel's 4.5 MB body cap. It lives apart
 * from extract.ts so that the mandate form (a client component) can read it without loading pdf-parse.
 */
export const MAX_INVOICE_BYTES = 4 * 1024 * 1024;
