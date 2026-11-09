import { chromeApi } from "./chrome";
import { asPageMessage, fromOwnPage, readConnectMessage } from "./connect";

// Runs only on Probarion's /extension page (the manifest's content_scripts). It takes the connect message the page
// posts to its own window and hands it to the worker, which checks the sender and the nonce. When the worker kept the
// connection, it marks the page, so the page can say "Connected". The worker reads the message with the same
// readConnectMessage, so it gets it in the page's shape (asPageMessage), not the stripped one this script read.

window.addEventListener("message", (event: MessageEvent) => {
  if (!fromOwnPage(event, window)) return;
  const message = readConnectMessage(event.data, Date.now());
  if (message === null) return;
  chromeApi()
    .runtime.sendMessage({ type: "probarion:connect", message: asPageMessage(message) })
    .then(
      (answer) => {
        if (
          typeof answer === "object" &&
          answer !== null &&
          (answer as { ok?: unknown }).ok === true
        ) {
          document.documentElement.dataset.probarionExtension = "connected";
        }
      },
      () => {},
    );
});
