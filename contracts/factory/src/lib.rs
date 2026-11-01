//! Probarion factory: creates `<name>.<factory>` vaults with no access keys (I9), from a global
//! contract referenced by code hash (primary) or from wasm stored here (fallback). It cannot
//! modify, upgrade or take funds from any vault it created. ABI: interfaces §5.
use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::{Base58CryptoHash, U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    env, near, AccountId, BorshStorageKey, CryptoHash, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError,
};

#[cfg(test)]
mod tests;

pub const MAX_NOTES: usize = 256;
pub const MAX_PAGE: u64 = 100;
const CODE_PREFIX: &[u8] = b"code:";
pub const GAS_VAULT_NEW: Gas = Gas::from_tgas(30);
pub const GAS_ON_VAULT_CREATED: Gas = Gas::from_tgas(15);

/// `^[a-z0-9][a-z0-9_-]{1,30}$` (interfaces §5). NEAR account-id rules (for example, no
/// trailing `-`) are checked when `<name>.<factory>` is parsed.
pub fn valid_name(name: &str) -> bool {
    let b = name.as_bytes();
    (2..=31).contains(&b.len())
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

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

    /// Global: `min_deposit`. Embedded: also the storage for the vault's copy of the code.
    fn required_deposit(&self, version: &Version) -> u128 {
        match version.mode {
            Mode::Global => self.min_deposit,
            Mode::Embedded => {
                self.min_deposit
                    + env::storage_byte_cost().as_yoctonear() * u128::from(version.code_len)
            }
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

#[near]
impl Factory {
    /// Creates `<name>.<factory>` for the caller (the new vault's owner). The account gets no keys (I9).
    #[payable]
    pub fn create_vault(
        &mut self,
        name: String,
        approvers: Vec<AccountId>,
        daily_backstop: U128,
        held_ttl_ns: U64,
    ) -> Promise {
        if !valid_name(&name) {
            fail("InvalidInput")
        }
        let account_id: AccountId = format!("{name}.{}", env::current_account_id())
            .parse()
            .unwrap_or_else(|_| fail("InvalidInput"));
        let index = self.versions.len();
        let version = index
            .checked_sub(1)
            .and_then(|i| self.versions.get(i))
            .cloned()
            .unwrap_or_else(|| fail("InvalidInput"));
        let deposit = env::attached_deposit();
        if deposit.as_yoctonear() < self.required_deposit(&version) {
            fail("InsufficientDeposit")
        }
        let owner = env::predecessor_account_id();
        let init = json!({
            "owner": owner,
            "approvers": approvers,
            "usdc": self.usdc,
            "intents": self.intents,
            "allowed_assets": self.allowed_assets,
            "daily_backstop": daily_backstop,
            "held_ttl_ns": held_ttl_ns,
        });
        let batch = Promise::new(account_id).create_account().transfer(deposit);
        let batch = match version.mode {
            Mode::Global => batch.use_global_contract(version.code_hash),
            Mode::Embedded => batch.deploy_contract(
                env::storage_read(&code_key(&version.code_hash))
                    .unwrap_or_else(|| fail("InvalidInput")),
            ),
        };
        batch
            .function_call(
                "new",
                init.to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_VAULT_NEW,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_VAULT_CREATED)
                    .on_vault_created(name, owner, U128(deposit.as_yoctonear()), index),
            )
    }

    #[private]
    pub fn on_vault_created(
        &mut self,
        name: String,
        owner: AccountId,
        deposit: U128,
        version: u32,
    ) -> Option<AccountId> {
        let account_id: AccountId = format!("{name}.{}", env::current_account_id())
            .parse()
            .unwrap_or_else(|_| fail("InvalidInput"));
        if matches!(
            env::promise_result_checked(0, 64),
            Err(PromiseError::Failed)
        ) {
            // The batch rolled back (for example, the name was taken): give the deposit back.
            Promise::new(owner)
                .transfer(NearToken::from_yoctonear(deposit.0))
                .detach();
            return None;
        }
        self.vaults.push(VaultRecord {
            account_id: account_id.clone(),
            owner: owner.clone(),
            version,
            created_at_ns: U64(env::block_timestamp()),
        });
        self.vault_index.insert(account_id.clone(), version);
        FactoryEvent::VaultCreated {
            account_id: account_id.clone(),
            owner,
            version,
        }
        .emit();
        Some(account_id)
    }
}
