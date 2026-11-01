//! Every error code has a unit test, and the vault source never calls add_public_key (I8).
use probarion_vault::ErrorCode;
use std::fs;
use std::path::{Path, PathBuf};

fn vault_src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn read_sources(dir: &Path, out: &mut String) {
    for entry in fs::read_dir(dir).expect("src dir") {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            read_sources(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push_str(&fs::read_to_string(&path).expect("source file"));
        }
    }
}

#[test]
fn every_error_code_has_a_unit_test() {
    let mut src = String::new();
    read_sources(&vault_src(), &mut src);
    // The reduced contract (no src/held.rs; see plan 02) never raises the four hold-only codes.
    let reduced = !vault_src().join("held.rs").exists();
    let hold_only = ["NotApprover", "NotHeld", "HoldExpired", "HoldNotExpired"];
    let missing: Vec<&str> = ErrorCode::ALL
        .iter()
        .map(|c| c.as_str())
        .filter(|c| !(reduced && hold_only.contains(c)))
        .filter(|c| !src.contains(&format!("\"PROBARION:{c}\"")))
        .collect();
    assert!(
        missing.is_empty(),
        "error codes without a unit test: {missing:?}"
    );
}

// probarion-claim: I8
#[test]
fn the_vault_never_calls_add_public_key() {
    let mut src = String::new();
    read_sources(&vault_src(), &mut src);
    assert!(
        !src.contains("add_public_key"),
        "I8: the vault must never register a key in intents.near"
    );
}
