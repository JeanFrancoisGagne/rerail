/**
 * A native session's asks for its next deliveries (`await-deliveries`). An ask is held until the session has deliveries
 * for a poll to take, the session closes, or the client that sent it goes away; nothing else ends it, so an idle session
 * costs the daemon no request and no timer.
 *
 * `due` says the session gained deliveries since the last poll began taking them: an ask that comes after such a gain is
 * answered at once, so a steer pending between one poll and the next ask is never left waiting for a later event. A new
 * session starts due: an ask before its first poll is answered at once, and the poll after it takes what it owes.
 */
export class DeliveryWait {
  #due = true;
  #held = 0;
  #wake = Promise.withResolvers<void>();

  /** Whether an ask is held now: its client is still connected, so the session's lease does not run out under it. */
  get held(): boolean {
    return this.#held > 0;
  }

  /** The session has deliveries, or is closing: every ask held now is answered. */
  wake(): void {
    this.#due = true;
    this.#wake.resolve();
    this.#wake = Promise.withResolvers<void>();
  }

  /** A poll begins taking the session's deliveries; a gain after this point makes the next ask due again. */
  taking(): void {
    this.#due = false;
  }

  /** Settles once the session is due, at once when it already is, or when `signal` (the client's connection) ends. */
  async until(signal: AbortSignal | undefined): Promise<void> {
    if (this.#due || signal?.aborted === true) return;
    const gone = Promise.withResolvers<void>();
    const leave = (): void => gone.resolve();
    signal?.addEventListener("abort", leave, { once: true });
    this.#held += 1;
    try {
      await Promise.race([this.#wake.promise, gone.promise]);
    } finally {
      this.#held -= 1;
      signal?.removeEventListener("abort", leave);
    }
  }
}
