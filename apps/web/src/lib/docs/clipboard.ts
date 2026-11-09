/**
 * Copies text. False, never a throw, when the browser has no clipboard (an insecure context, an old browser) or
 * refuses it (permission denied): the caller shows "Copy failed".
 */
export async function copyText(
  text: string,
  clipboard: Pick<Clipboard, "writeText"> | undefined = globalThis.navigator?.clipboard,
): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
