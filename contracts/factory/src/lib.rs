//! Probarion factory: creates `<name>.<factory>` vaults with no access keys (I9), from a global
//! contract referenced by code hash (primary) or from wasm stored here (fallback). It cannot
//! modify, upgrade or take funds from any vault it created. ABI: interfaces §5.
use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::{Base58CryptoHash, U128, U64};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, AccountId, BorshStorageKey, CryptoHash, PanicOnDefault};

#[cfg(test)]
mod tests;

pub const MAX_NOTES: usize = 256;
pub const MAX_PAGE: u64 = 100;
const CODE_PREFIX: &[u8] = b"code:";

/// Aborts with `PROBARION:<code>`. The factory reuses the vault codes NotOwner, InvalidInput
/// and InsufficientDeposit.
pub fn fail(code: &str) -> ! {
    env::panic_str(&format!("PROBARION:{code}"))
}

/// Storage key of embedded wasm with sha256 `hash`.
pub fn code_key(hash: &CryptoHash) -> Vec<u8> {
    [CODE_PREFIX, hash.as_slice()].concat()
}

/// The one-yocto rule (interfaces v2 §4.2): factory owner methods need exactly 1 yoctoNEAR, which
/// only a full-access key can attach.
pub fn require_one_yocto() {
    if env::attached_deposit().as_yoctonear() != 1 {
        fail("RequiresOneYocto")
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mode {
    /// The vault account uses the global contract with this code hash (NEP-591).
    Global,
    /// The vault account gets a copy of the wasm stored in this factory.
    Embedded,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Global => "global",
            Mode::Embedded => "embedded",
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Version {
    pub code_hash: CryptoHash,
    pub mode: Mode,
    /// Bytes of the stored wasm (embedded only); used for the storage part of the deposit.
    pub code_len: u64,
    pub notes: String,
    pub at_ns: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct VersionView {
    pub index: u32,
    pub code_hash: String,
    pub mode: String,
    pub notes: String,
    pub at_ns: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct VaultRecord {
    pub account_id: AccountId,
    pub owner: AccountId,
    pub version: u32,
    pub created_at_ns: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct FactoryConfig {
    pub owner: AccountId,
    pub usdc: AccountId,
    pub intents: AccountId,
    pub allowed_assets: Vec<AccountId>,
    pub min_deposit: U128,
    pub current_version: Option<u32>,
}

#[near(event_json(standard = "probarion_factory"))]
pub enum FactoryEvent {
    #[event_version("1.0.0")]
    VaultCreated {
        account_id: AccountId,
        owner: AccountId,
        version: u32,
    },
    #[event_version("1.0.0")]
    VersionAdded {
        index: u32,
        code_hash: String,
        mode: String,
    },
}

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    Versions,
    Vaults,
    VaultIndex,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Factory {
    owner: AccountId,
    usdc: AccountId,
    intents: AccountId,
    allowed_assets: Vec<AccountId>,
    min_deposit: u128,
    /// Version index = position + 1. The last version is the current one.
    versions: Vector<Version>,
    vaults: Vector<VaultRecord>,
    vault_index: LookupMap<AccountId, u32>,
}

#[near]
impl Factory {
    #[init]
    pub fn new(
        owner: AccountId,
        usdc: AccountId,
        intents: AccountId,
        allowed_assets: Vec<AccountId>,
        min_deposit: U128,
    ) -> Self {
        Self {
            owner,
            usdc,
            intents,
            allowed_assets,
            min_deposit: min_deposit.0,
            versions: Vector::new(StorageKey::Versions),
            vaults: Vector::new(StorageKey::Vaults),
            vault_index: LookupMap::new(StorageKey::VaultIndex),
        }
    }

    /// Raw wasm as the call input (`file-args` in near-cli-rs), stored under its sha256.
    #[payable]
    pub fn store_code(&mut self) -> String {
        self.assert_owner();
        require_one_yocto();
        let code = env::input().unwrap_or_default();
        self.internal_store_code(&code)
    }

    #[payable]
    pub fn add_version(&mut self, code_hash: String, mode: String, notes: String) -> u32 {
        self.assert_owner();
        require_one_yocto();
        if notes.len() > MAX_NOTES {
            fail("InvalidInput")
        }
        let parsed =
            Base58CryptoHash::try_from(code_hash.as_str()).unwrap_or_else(|_| fail("InvalidInput"));
        let bytes: &[u8; 32] = parsed.as_ref();
        let hash: CryptoHash = *bytes;
        let (mode, code_len) = match mode.as_str() {
            "global" => (Mode::Global, 0),
            "embedded" => {
                let code =
                    env::storage_read(&code_key(&hash)).unwrap_or_else(|| fail("InvalidInput"));
                (Mode::Embedded, code.len() as u64)
            }
            _ => fail("InvalidInput"),
        };
        self.versions.push(Version {
            code_hash: hash,
            mode,
            code_len,
            notes,
            at_ns: env::block_timestamp(),
        });
        let index = self.versions.len();
        FactoryEvent::VersionAdded {
            index,
            code_hash: parsed.to_string(),
            mode: mode.as_str().to_string(),
        }
        .emit();
        index
    }

    pub fn versions(&self) -> Vec<VersionView> {
        self.versions
            .iter()
            .enumerate()
            .map(|(i, v)| VersionView {
                index: i as u32 + 1,
                code_hash: Base58CryptoHash::from(v.code_hash).to_string(),
                mode: v.mode.as_str().to_string(),
                notes: v.notes.clone(),
                at_ns: U64(v.at_ns),
            })
            .collect()
    }

    pub fn vault_version(&self, account_id: AccountId) -> Option<u32> {
        self.vault_index.get(&account_id).copied()
    }

    pub fn list_vaults(&self, from_index: u64, limit: u64) -> Vec<VaultRecord> {
        let end = from_index
            .saturating_add(limit.min(MAX_PAGE))
            .min(u64::from(self.vaults.len()));
        (from_index..end)
            .filter_map(|i| self.vaults.get(u32::try_from(i).ok()?).cloned())
            .collect()
    }

    pub fn get_config(&self) -> FactoryConfig {
        let current = self.versions.len();
        FactoryConfig {
            owner: self.owner.clone(),
            usdc: self.usdc.clone(),
            intents: self.intents.clone(),
            allowed_assets: self.allowed_assets.clone(),
            min_deposit: U128(self.min_deposit),
            current_version: (current > 0).then_some(current),
        }
    }
}

impl Factory {
    fn assert_owner(&self) {
        if env::predecessor_account_id() != self.owner {
            fail("NotOwner")
        }
    }

    pub fn internal_store_code(&mut self, code: &[u8]) -> String {
        if code.is_empty() {
            fail("InvalidInput")
        }
        let hash = env::sha256_array(code);
        env::storage_write(&code_key(&hash), code);
        Base58CryptoHash::from(hash).to_string()
    }
}
