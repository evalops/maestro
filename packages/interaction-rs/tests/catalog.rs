use maestro_interaction::{Action, ActionCatalog, CatalogError, Shortcut};

#[test]
fn catalog_rejects_ambiguous_ids_and_shortcuts() {
    let duplicate = [
        Action::new("save", "First", 1),
        Action::new("save", "Second", 2),
    ];
    assert!(matches!(
        ActionCatalog::new(&duplicate),
        Err(CatalogError::DuplicateId("save"))
    ));
    let bindings = [
        Action::new("save", "Save", 1).shortcut(Shortcut::Enter),
        Action::new("cancel", "Cancel", 2).shortcut(Shortcut::Enter),
    ];
    assert!(matches!(
        ActionCatalog::new(&bindings),
        Err(CatalogError::DuplicateShortcut(Shortcut::Enter))
    ));
}

#[test]
fn lookup_and_help_share_the_declared_metadata() {
    let actions = [Action::new("save", "Save", 42)
        .description("Save preferences")
        .shortcut(Shortcut::Enter)];
    let catalog = ActionCatalog::new(&actions).unwrap();
    assert_eq!(catalog.find("save").unwrap().value, 42);
    assert!(catalog.find("missing").is_none());
    assert_eq!(catalog.binding(Shortcut::Enter).unwrap().id, "save");
    assert_eq!(catalog.help(), "save: Save preferences (Enter)");
}
