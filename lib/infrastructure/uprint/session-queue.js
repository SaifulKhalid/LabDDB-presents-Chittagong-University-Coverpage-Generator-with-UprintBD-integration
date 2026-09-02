/**
 * lib/infrastructure/uprint/session-queue.js — Serialized execution queue.
 * -----------------------------------------------------------------------------
 * INVARIANT INV-13: The UprintBD session is serialized.
 * UprintBD uploads are stateful (the site hands back a recordId per upload redirect),
 * so two concurrent mints through one cookie jar could cross wires.
 */

'use strict';

class SessionQueue {
  constructor() {
    this.chain = Promise.resolve();
  }

  /**
   * Enqueue a task to run strictly after all preceding tasks finish.
   * @param {() => Promise<any>} task
   * @returns {Promise<any>}
   */
  enqueue(task) {
    const next = this.chain.then(() => task());
    // Keep the chain alive even if a task throws
    this.chain = next.catch(() => {});
    return next;
  }
}

module.exports = {
  SessionQueue,
};
