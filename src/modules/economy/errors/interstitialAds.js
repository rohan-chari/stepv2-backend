const {
  ValidationError,
  ConflictError,
} = require("../../../shared/errors/AppError");

class InvalidInterstitialRequestError extends ValidationError {
  constructor() {
    super(
      "Invalid interstitial eligibility request",
      "INVALID_INTERSTITIAL_REQUEST",
    );
  }
}

class InvalidInterstitialPermitRequestError extends ValidationError {
  constructor() {
    super(
      "Invalid interstitial permit request",
      "INVALID_INTERSTITIAL_PERMIT_REQUEST",
    );
  }
}

class InvalidInterstitialImpressionError extends ValidationError {
  constructor() {
    super(
      "Invalid interstitial impression",
      "INVALID_INTERSTITIAL_IMPRESSION",
    );
  }
}

class InvalidInterstitialPermitIdError extends ValidationError {
  constructor() {
    super(
      "Invalid interstitial permit id",
      "INVALID_INTERSTITIAL_PERMIT_ID",
    );
  }
}

class InterstitialEventConflictError extends ConflictError {
  constructor() {
    super("Interstitial event conflict", "INTERSTITIAL_EVENT_CONFLICT");
  }
}

module.exports = {
  InvalidInterstitialRequestError,
  InvalidInterstitialPermitRequestError,
  InvalidInterstitialImpressionError,
  InvalidInterstitialPermitIdError,
  InterstitialEventConflictError,
};
