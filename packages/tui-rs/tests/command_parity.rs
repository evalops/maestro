#[test]
fn native_command_sources_have_no_typescript_or_residual_fallbacks() {
    let context = include_str!("../src/context_cli.rs");
    let run = include_str!("../src/run_cli.rs");
    let lsp = include_str!("../src/lsp.rs");

    for (name, source) in [("context", context), ("run", run), ("lsp", lsp)] {
        assert!(
            !source.contains("Residual gaps") && !source.contains("remain residual"),
            "{name} still declares incomplete native behavior"
        );
        assert!(
            !source.contains("TypeScript"),
            "{name} still depends on the TypeScript runtime"
        );
    }
    assert!(!lsp.contains("dist/lsp"));
    assert!(!lsp.contains("Command::new(runtime)"));
}
