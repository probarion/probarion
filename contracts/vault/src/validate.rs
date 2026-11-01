//! Input format checks shared by mandates, spends and anchors.
use near_sdk::AccountId;

use crate::types::Chain;

const BASE58: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// 64 lowercase hex characters (a sha256 digest).
pub fn is_hex64(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `0x` followed by 40 hex digits in any case (EIP-55 checksummed or not).
pub fn is_evm_address(s: &str) -> bool {
    s.len() == 42 && s.starts_with("0x") && s.bytes().skip(2).all(|b| b.is_ascii_hexdigit())
}

/// Base58 (Bitcoin alphabet), 32–44 characters.
pub fn is_solana_address(s: &str) -> bool {
    (32..=44).contains(&s.len()) && s.bytes().all(|b| BASE58.contains(&b))
}

/// POA asset ids carry their chain as a prefix: `base-…` or `sol-…` (interfaces §3).
pub fn asset_matches_chain(chain: Chain, asset: &AccountId) -> bool {
    let prefix = match chain {
        Chain::Base => "base-",
        Chain::Solana => "sol-",
    };
    asset.as_str().starts_with(prefix)
}

/// Idempotency keys: 1–64 bytes.
pub fn is_ref(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::*;

    #[test]
    fn hex64_is_lowercase_sha256_hex() {
        assert!(is_hex64(&hex(0xab)));
        assert!(!is_hex64(&hex(0xab).to_uppercase()));
        assert!(!is_hex64(&hex(0xab)[..63]));
        assert!(!is_hex64(&format!("{}g", &hex(0xab)[..63])));
    }

    #[test]
    fn evm_address_needs_0x_and_40_hex_digits_any_case() {
        assert!(is_evm_address(EVM_ADDR));
        assert!(is_evm_address(EVM_MIXED));
        assert!(!is_evm_address(&format!("0X{}", "1".repeat(40))));
        assert!(!is_evm_address(&format!("0x{}", "1".repeat(39))));
        assert!(!is_evm_address(&format!("0x{}", "1".repeat(41))));
        assert!(!is_evm_address(&format!("0x{} ", "1".repeat(39))));
        assert!(!is_evm_address(&format!("0x{}g", "1".repeat(39))));
    }

    #[test]
    fn solana_address_is_base58_of_32_to_44_chars() {
        assert!(is_solana_address(SOL_ADDR));
        assert!(!is_solana_address(&SOL_ADDR[..31]));
        assert!(!is_solana_address(&format!("{SOL_ADDR}1")));
        for bad in ['0', 'O', 'I', 'l'] {
            assert!(
                !is_solana_address(&format!("{bad}{}", &SOL_ADDR[1..])),
                "accepted {bad}"
            );
        }
    }

    #[test]
    fn asset_prefix_must_match_the_chain() {
        assert!(asset_matches_chain(Chain::Base, &base_asset()));
        assert!(asset_matches_chain(Chain::Solana, &sol_asset()));
        assert!(!asset_matches_chain(Chain::Base, &sol_asset()));
        assert!(!asset_matches_chain(Chain::Solana, &base_asset()));
        assert!(asset_matches_chain(
            Chain::Base,
            &acc("base-usdc.probarion.testnet")
        ));
    }

    #[test]
    fn refs_are_one_to_sixty_four_bytes() {
        assert!(is_ref("INV-001"));
        assert!(is_ref(&"x".repeat(64)));
        assert!(!is_ref(""));
        assert!(!is_ref(&"x".repeat(65)));
    }
}
