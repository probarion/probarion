//! `PROBARION:<Code>` panics (interfaces §4.3). The code is readable on any explorer.
use near_sdk::{env, NearToken};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorCode {
    NoMandate,
    MandateInactive,
    MandateExpired,
    NotMandateAgent,
    ZeroAmount,
    OverPerPayment,
    UsesExhausted,
    OverMandateTotal,
    DuplicateInvoice,
    DuplicateRef,
    OverDailyBackstop,
    Frozen,
    NotAgent,
    NotOwner,
    NotApprover,
    NotLedgerKey,
    NotHeld,
    HoldExpired,
    HoldNotExpired,
    BadSeq,
    AssetNotAllowed,
    InvalidInput,
    InsufficientDeposit,
    RequiresOneYocto,
}

impl ErrorCode {
    pub const ALL: [ErrorCode; 24] = [
        ErrorCode::NoMandate,
        ErrorCode::MandateInactive,
        ErrorCode::MandateExpired,
        ErrorCode::NotMandateAgent,
        ErrorCode::ZeroAmount,
        ErrorCode::OverPerPayment,
        ErrorCode::UsesExhausted,
        ErrorCode::OverMandateTotal,
        ErrorCode::DuplicateInvoice,
        ErrorCode::DuplicateRef,
        ErrorCode::OverDailyBackstop,
        ErrorCode::Frozen,
        ErrorCode::NotAgent,
        ErrorCode::NotOwner,
        ErrorCode::NotApprover,
        ErrorCode::NotLedgerKey,
        ErrorCode::NotHeld,
        ErrorCode::HoldExpired,
        ErrorCode::HoldNotExpired,
        ErrorCode::BadSeq,
        ErrorCode::AssetNotAllowed,
        ErrorCode::InvalidInput,
        ErrorCode::InsufficientDeposit,
        ErrorCode::RequiresOneYocto,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::NoMandate => "NoMandate",
            ErrorCode::MandateInactive => "MandateInactive",
            ErrorCode::MandateExpired => "MandateExpired",
            ErrorCode::NotMandateAgent => "NotMandateAgent",
            ErrorCode::ZeroAmount => "ZeroAmount",
            ErrorCode::OverPerPayment => "OverPerPayment",
            ErrorCode::UsesExhausted => "UsesExhausted",
            ErrorCode::OverMandateTotal => "OverMandateTotal",
            ErrorCode::DuplicateInvoice => "DuplicateInvoice",
            ErrorCode::DuplicateRef => "DuplicateRef",
            ErrorCode::OverDailyBackstop => "OverDailyBackstop",
            ErrorCode::Frozen => "Frozen",
            ErrorCode::NotAgent => "NotAgent",
            ErrorCode::NotOwner => "NotOwner",
            ErrorCode::NotApprover => "NotApprover",
            ErrorCode::NotLedgerKey => "NotLedgerKey",
            ErrorCode::NotHeld => "NotHeld",
            ErrorCode::HoldExpired => "HoldExpired",
            ErrorCode::HoldNotExpired => "HoldNotExpired",
            ErrorCode::BadSeq => "BadSeq",
            ErrorCode::AssetNotAllowed => "AssetNotAllowed",
            ErrorCode::InvalidInput => "InvalidInput",
            ErrorCode::InsufficientDeposit => "InsufficientDeposit",
            ErrorCode::RequiresOneYocto => "RequiresOneYocto",
        }
    }

    pub fn message(self) -> String {
        format!("PROBARION:{}", self.as_str())
    }
}

/// Aborts the call with `PROBARION:<Code>`. All state changes of the call are reverted.
pub fn fail(code: ErrorCode) -> ! {
    env::panic_str(&code.message())
}

/// The one-yocto rule (interfaces v2 §4.2): exactly 1 yoctoNEAR attached. Only a full-access key,
/// through an explicit wallet prompt, can attach a deposit. A dapp-login Function-Call key, or an
/// XSS in the web app, therefore cannot call a method that requires this.
pub fn require_one_yocto() {
    if env::attached_deposit() != NearToken::from_yoctonear(1) {
        fail(ErrorCode::RequiresOneYocto)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_match_the_interface_list_in_order() {
        let names: Vec<&str> = ErrorCode::ALL.iter().map(|c| c.as_str()).collect();
        assert_eq!(
            names.join(","),
            "NoMandate,MandateInactive,MandateExpired,NotMandateAgent,ZeroAmount,OverPerPayment,\
             UsesExhausted,OverMandateTotal,DuplicateInvoice,DuplicateRef,OverDailyBackstop,Frozen,\
             NotAgent,NotOwner,NotApprover,NotLedgerKey,NotHeld,HoldExpired,HoldNotExpired,BadSeq,\
             AssetNotAllowed,InvalidInput,InsufficientDeposit,RequiresOneYocto"
        );
    }

    #[test]
    fn as_str_is_the_variant_name() {
        for code in ErrorCode::ALL {
            assert_eq!(code.as_str(), format!("{code:?}"));
            assert_eq!(code.message(), format!("PROBARION:{code:?}"));
        }
    }

    #[test]
    #[should_panic(expected = "PROBARION:Frozen")]
    fn fail_panics_with_the_prefixed_code() {
        fail(ErrorCode::Frozen)
    }
}
