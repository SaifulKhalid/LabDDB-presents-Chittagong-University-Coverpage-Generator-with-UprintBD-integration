/**
 * lib/domain/errors.js — Centralized typed error hierarchy.
 * -----------------------------------------------------------------------------
 * Clean, structured errors across Domain, Application, and Infrastructure layers.
 * Prevents leaking stack traces or internal secrets to callers while preserving
 * structured status codes, error codes, and retryability flags.
 */

'use strict';

class DomainError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    Object.assign(this, extra);
  }
}

class LedgerError extends DomainError {
  constructor(message, status = 400, extra = {}) {
    super(message, status, extra);
  }
}

class AuthError extends DomainError {
  constructor(message, status = 401, extra = {}) {
    super(message, status, extra);
  }
}

class ValidationError extends DomainError {
  constructor(message, status = 400, extra = {}) {
    super(message, status, extra);
  }
}

class ConflictError extends DomainError {
  constructor(message = 'Resource conflict or concurrent modification.', status = 412, extra = {}) {
    super(message, status, extra);
  }
}

class ProviderError extends DomainError {
  constructor(message, status = 502, extra = {}) {
    super(message, status, extra);
    this.retryable = !!extra.retryable;
  }
}

module.exports = {
  DomainError,
  LedgerError,
  AuthError,
  ValidationError,
  ConflictError,
  ProviderError,
};
