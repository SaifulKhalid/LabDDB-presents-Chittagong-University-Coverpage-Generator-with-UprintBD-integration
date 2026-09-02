/**
 * lib/domain/print-provider.js — Formal PrintProvider contract interface.
 * -----------------------------------------------------------------------------
 * Decouples the core system from UprintBD's specific implementation details.
 * Any current or future print provider (e.g. an official Uprint API, a direct CU
 * network printer queue, or a staging simulator) implements this interface.
 */

'use strict';

class PrintProvider {
  /**
   * Authenticate / ensure valid session with the print provider.
   * @returns {Promise<boolean>}
   */
  async authenticate() {
    throw new Error('PrintProvider.authenticate() must be implemented.');
  }

  /**
   * Upload a document and configure print options.
   * @param {Uint8Array|Buffer} pdfBytes
   * @param {object} options { filename, copies, color }
   * @returns {Promise<{ ok: boolean, recordId: string, otp: string, pages: number, copies: number, cost: number, currency: string, validForSeconds: number }>}
   */
  async uploadAndQueue(pdfBytes, options) {
    throw new Error('PrintProvider.uploadAndQueue() must be implemented.');
  }

  /**
   * Retrieve active OTP for an existing print request record.
   * @param {string} recordId
   * @returns {Promise<{ otp: string, validForSeconds: number }>}
   */
  async retrieveOtp(recordId) {
    throw new Error('PrintProvider.retrieveOtp() must be implemented.');
  }

  /**
   * Fetch recent print history rows from the provider.
   * @param {object} [filters] { sinceMs, startDate, endDate }
   * @returns {Promise<Array<{ recordId?: string, filename: string, status: string, cost?: number, deviceId?: string, dateTime?: string }>>}
   */
  async getPrintHistory(filters) {
    throw new Error('PrintProvider.getPrintHistory() must be implemented.');
  }

  /**
   * Delete an active, unprinted request before releasing student hold.
   * @param {string} recordId
   * @returns {Promise<boolean>}
   */
  async deletePrintRequest(recordId) {
    throw new Error('PrintProvider.deletePrintRequest() must be implemented.');
  }

  /**
   * Fetch current institutional account balance.
   * @returns {Promise<number>}
   */
  async getAccountBalance() {
    throw new Error('PrintProvider.getAccountBalance() must be implemented.');
  }
}

module.exports = {
  PrintProvider,
};
