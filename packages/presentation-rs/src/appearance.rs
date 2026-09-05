//! The product appearance catalog drives production commands and preview scenes.
use crate::dex_delight::{DexAccent, DexAccessory};
use maestro_interaction::Action;

#[derive(Clone, Copy)]
pub enum Appearance {
    Accessory(DexAccessory),
    Accent(DexAccent),
}

pub const LOOKS: [Action<Appearance>; 12] = [
    Action::new(
        "accessory-none",
        "Accessory: none",
        Appearance::Accessory(DexAccessory::None),
    ),
    Action::new(
        "accessory-glasses",
        "Accessory: glasses",
        Appearance::Accessory(DexAccessory::Glasses),
    ),
    Action::new(
        "accessory-beanie",
        "Accessory: beanie",
        Appearance::Accessory(DexAccessory::Beanie),
    ),
    Action::new(
        "accessory-antenna",
        "Accessory: antenna",
        Appearance::Accessory(DexAccessory::Antenna),
    ),
    Action::new(
        "accessory-sprout",
        "Accessory: sprout",
        Appearance::Accessory(DexAccessory::Sprout),
    ),
    Action::new(
        "accessory-cat-ears",
        "Accessory: cat ears",
        Appearance::Accessory(DexAccessory::CatEars),
    ),
    Action::new(
        "accessory-crown",
        "Accessory: crown",
        Appearance::Accessory(DexAccessory::Crown),
    ),
    Action::new(
        "accessory-bow",
        "Accessory: bow",
        Appearance::Accessory(DexAccessory::Bow),
    ),
    Action::new(
        "accent-violet",
        "Accent: violet",
        Appearance::Accent(DexAccent::Violet),
    ),
    Action::new(
        "accent-mint",
        "Accent: mint",
        Appearance::Accent(DexAccent::Mint),
    ),
    Action::new(
        "accent-amber",
        "Accent: amber",
        Appearance::Accent(DexAccent::Amber),
    ),
    Action::new(
        "accent-rose",
        "Accent: rose",
        Appearance::Accent(DexAccent::Rose),
    ),
];
