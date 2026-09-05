//! Bind an orchestrated preview to its source inputs when Cargo builds it.
fn main() {
    println!("cargo:rerun-if-env-changed=MAESTRO_PREVIEW_SOURCE_DIGEST");
    let digest =
        std::env::var("MAESTRO_PREVIEW_SOURCE_DIGEST").unwrap_or_else(|_| "unbound".into());
    assert!(
        digest == "unbound"
            || (digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit())),
        "invalid preview source digest"
    );
    println!("cargo:rustc-env=MAESTRO_PREVIEW_SOURCE_DIGEST={digest}");
}
