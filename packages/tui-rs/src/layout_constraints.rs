//! Layout Constraints System
//!
//! A comprehensive layout system for terminal UIs with:
//! - Min/max width/height constraints
//! - Flex-like proportional distribution
//! - Responsive breakpoints
//! - Priority-based degradation
//!
//! Ported from OpenAI Codex CLI patterns (MIT licensed).

use std::collections::HashMap;

// ─────────────────────────────────────────────────────────────────────────────
// CORE CONSTRAINTS
// ─────────────────────────────────────────────────────────────────────────────

/// Spacing values for padding and margin.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Spacing {
    /// Horizontal spacing (left/right).
    pub x: usize,
    /// Vertical spacing (top/bottom).
    pub y: usize,
}

impl Spacing {
    /// Create uniform spacing.
    #[must_use]
    pub fn uniform(value: usize) -> Self {
        Self { x: value, y: value }
    }

    /// Create horizontal-only spacing.
    #[must_use]
    pub fn horizontal(x: usize) -> Self {
        Self { x, y: 0 }
    }

    /// Create vertical-only spacing.
    #[must_use]
    pub fn vertical(y: usize) -> Self {
        Self { x: 0, y }
    }

    /// Total horizontal space (both sides).
    #[must_use]
    pub fn total_x(&self) -> usize {
        self.x * 2
    }

    /// Total vertical space (both sides).
    #[must_use]
    pub fn total_y(&self) -> usize {
        self.y * 2
    }
}

/// Constraints for a layout element.
#[derive(Debug, Clone, Copy)]
pub struct LayoutConstraints {
    /// Minimum width in columns.
    pub min_width: usize,
    /// Maximum width in columns.
    pub max_width: usize,
    /// Minimum height in rows.
    pub min_height: usize,
    /// Maximum height in rows.
    pub max_height: usize,
    /// Inner padding.
    pub padding: Spacing,
    /// Outer margin.
    pub margin: Spacing,
}

impl Default for LayoutConstraints {
    fn default() -> Self {
        Self {
            min_width: 1,
            max_width: usize::MAX,
            min_height: 1,
            max_height: usize::MAX,
            padding: Spacing::default(),
            margin: Spacing::default(),
        }
    }
}

impl LayoutConstraints {
    /// Create new constraints with min/max width.
    #[must_use]
    pub fn width(min: usize, max: usize) -> Self {
        Self {
            min_width: min,
            max_width: max,
            ..Default::default()
        }
    }

    /// Create new constraints with min/max height.
    #[must_use]
    pub fn height(min: usize, max: usize) -> Self {
        Self {
            min_height: min,
            max_height: max,
            ..Default::default()
        }
    }

    /// Create fixed width constraints.
    #[must_use]
    pub fn fixed_width(width: usize) -> Self {
        Self {
            min_width: width,
            max_width: width,
            ..Default::default()
        }
    }

    /// Create fixed height constraints.
    #[must_use]
    pub fn fixed_height(height: usize) -> Self {
        Self {
            min_height: height,
            max_height: height,
            ..Default::default()
        }
    }

    /// Set padding.
    #[must_use]
    pub fn with_padding(mut self, padding: Spacing) -> Self {
        self.padding = padding;
        self
    }

    /// Set margin.
    #[must_use]
    pub fn with_margin(mut self, margin: Spacing) -> Self {
        self.margin = margin;
        self
    }

    /// Calculate content width after padding and margin.
    #[must_use]
    pub fn content_width(&self, available: usize) -> usize {
        let outer = self.margin.total_x() + self.padding.total_x();
        available.saturating_sub(outer).max(1)
    }

    /// Calculate content height after padding and margin.
    #[must_use]
    pub fn content_height(&self, available: usize) -> usize {
        let outer = self.margin.total_y() + self.padding.total_y();
        available.saturating_sub(outer).max(1)
    }

    /// Clamp a width to these constraints.
    #[must_use]
    pub fn clamp_width(&self, width: usize) -> usize {
        width.clamp(self.min_width, self.max_width)
    }

    /// Clamp a height to these constraints.
    #[must_use]
    pub fn clamp_height(&self, height: usize) -> usize {
        height.clamp(self.min_height, self.max_height)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// RESPONSIVE WIDTH CALCULATION
// ─────────────────────────────────────────────────────────────────────────────

/// Calculate responsive width within constraints.
///
/// Uses a preferred ratio of terminal width, clamped to min/max bounds.
///
/// # Example
/// ```
/// use composer_tui::layout_constraints::responsive_width;
///
/// // Terminal is 120 columns, want 80% but clamp to [40, 100]
/// let width = responsive_width(120, 40, 100, 0.8);
/// assert_eq!(width, 96); // 120 * 0.8 = 96, within bounds
///
/// // Terminal is 50 columns
/// let width = responsive_width(50, 40, 100, 0.8);
/// assert_eq!(width, 40); // 50 * 0.8 = 40, exactly at min
/// ```
#[must_use]
pub fn responsive_width(
    terminal_width: usize,
    min: usize,
    max: usize,
    preferred_ratio: f32,
) -> usize {
    let preferred = (terminal_width as f32 * preferred_ratio) as usize;
    preferred.clamp(min, max)
}

/// Calculate content width accounting for borders and padding.
///
/// # Arguments
/// * `total_width` - Total available width
/// * `borders` - Whether borders are present (adds 4 for "│ " on each side)
/// * `padding_x` - Horizontal padding on each side
#[must_use]
pub fn content_width(total_width: usize, borders: bool, padding_x: usize) -> usize {
    let border_width = if borders { 4 } else { 0 };
    total_width
        .saturating_sub(border_width)
        .saturating_sub(padding_x * 2)
        .max(1)
}

// ─────────────────────────────────────────────────────────────────────────────
// FLEX DISTRIBUTION
// ─────────────────────────────────────────────────────────────────────────────

/// Options for a single flex item.
#[derive(Debug, Clone, Copy)]
pub struct FlexItem {
    /// Proportional weight (default 1.0).
    pub weight: f32,
    /// Minimum width in columns.
    pub min_width: usize,
    /// Maximum width in columns.
    pub max_width: usize,
}

impl Default for FlexItem {
    fn default() -> Self {
        Self {
            weight: 1.0,
            min_width: 1,
            max_width: usize::MAX,
        }
    }
}

impl FlexItem {
    /// Create a flex item with given weight.
    #[must_use]
    pub fn weight(weight: f32) -> Self {
        Self {
            weight,
            ..Default::default()
        }
    }

    /// Set minimum width.
    #[must_use]
    pub fn min(mut self, min: usize) -> Self {
        self.min_width = min;
        self
    }

    /// Set maximum width.
    #[must_use]
    pub fn max(mut self, max: usize) -> Self {
        self.max_width = max;
        self
    }

    /// Create a fixed-width item.
    #[must_use]
    pub fn fixed(width: usize) -> Self {
        Self {
            weight: 0.0,
            min_width: width,
            max_width: width,
        }
    }
}

/// Distribute width among flex items proportionally.
///
/// Algorithm:
/// 1. Subtract gaps from available width
/// 2. Assign fixed-width items first
/// 3. Distribute remaining width proportionally by weight
/// 4. Apply min/max constraints
/// 5. Redistribute remainder evenly
///
/// # Example
/// ```
/// use composer_tui::layout_constraints::{distribute_flex, FlexItem};
///
/// let items = vec![
///     FlexItem::weight(1.0).min(10),
///     FlexItem::weight(2.0).min(10),
///     FlexItem::weight(1.0).min(10),
/// ];
/// let widths = distribute_flex(100, &items, 2);
/// // Total weight = 4, available = 100 - 4 (gaps) = 96
/// // Item 0: 96 * 1/4 = 24
/// // Item 1: 96 * 2/4 = 48
/// // Item 2: 96 * 1/4 = 24
/// assert_eq!(widths, vec![24, 48, 24]);
/// ```
#[must_use]
pub fn distribute_flex(available: usize, items: &[FlexItem], gap: usize) -> Vec<usize> {
    if items.is_empty() {
        return vec![];
    }

    // Calculate available width after gaps
    let gap_total = gap * items.len().saturating_sub(1);
    let available_for_items = available.saturating_sub(gap_total);

    // First pass: handle fixed items and calculate remaining for flex
    let mut widths: Vec<usize> = vec![0; items.len()];
    let mut fixed_total = 0;

    for (i, item) in items.iter().enumerate() {
        if item.weight <= 0.0 {
            // Fixed width item - assign immediately
            let width = item.min_width.min(available_for_items);
            widths[i] = width;
            fixed_total += width;
        }
    }

    // Calculate total weight for flexible items
    let total_weight: f32 = items
        .iter()
        .filter(|i| i.weight > 0.0)
        .map(|i| i.weight)
        .sum();
    let available_for_flex = available_for_items.saturating_sub(fixed_total);

    // Second pass: distribute to flexible items
    let mut remaining = available_for_flex;

    for (i, item) in items.iter().enumerate() {
        if item.weight > 0.0 && total_weight > 0.0 {
            // Proportional width
            let proportion = item.weight / total_weight;
            let raw = (available_for_flex as f32 * proportion) as usize;

            // Apply constraints
            let width = raw.clamp(item.min_width, item.max_width);
            let width = width.min(remaining);
            widths[i] = width;
            remaining = remaining.saturating_sub(width);
        }
    }

    // Distribute remainder evenly to items that can grow
    while remaining > 0 {
        let mut distributed = false;
        for (i, item) in items.iter().enumerate() {
            if remaining == 0 {
                break;
            }
            if widths[i] < item.max_width {
                widths[i] += 1;
                remaining -= 1;
                distributed = true;
            }
        }
        if !distributed {
            break;
        }
    }

    widths
}

// ─────────────────────────────────────────────────────────────────────────────
// BREAKPOINTS
// ─────────────────────────────────────────────────────────────────────────────

/// Terminal size breakpoints for responsive layouts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Breakpoint {
    /// Very narrow (< 40 columns).
    Narrow,
    /// Compact (40-59 columns).
    Compact,
    /// Medium (60-79 columns).
    Medium,
    /// Standard (80-119 columns).
    Standard,
    /// Wide (120+ columns).
    Wide,
}

impl Breakpoint {
    /// Get breakpoint for a given terminal width.
    #[must_use]
    pub fn from_width(width: usize) -> Self {
        match width {
            0..=39 => Breakpoint::Narrow,
            40..=59 => Breakpoint::Compact,
            60..=79 => Breakpoint::Medium,
            80..=119 => Breakpoint::Standard,
            _ => Breakpoint::Wide,
        }
    }

    /// Get minimum width for this breakpoint.
    #[must_use]
    pub fn min_width(self) -> usize {
        match self {
            Breakpoint::Narrow => 0,
            Breakpoint::Compact => 40,
            Breakpoint::Medium => 60,
            Breakpoint::Standard => 80,
            Breakpoint::Wide => 120,
        }
    }

    /// Check if width matches this breakpoint or larger.
    #[must_use]
    pub fn matches(self, width: usize) -> bool {
        width >= self.min_width()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIORITY DEGRADATION
// ─────────────────────────────────────────────────────────────────────────────

/// Priority level for layout elements (higher = more important).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Priority {
    /// Lowest priority - hidden first.
    Low = 0,
    /// Normal priority.
    Normal = 1,
    /// Higher priority.
    High = 2,
    /// Must always be shown.
    Essential = 3,
}

/// A layout zone with priority-based visibility.
#[derive(Debug, Clone)]
pub struct PriorityZone {
    /// Zone identifier.
    pub id: String,
    /// Priority level.
    pub priority: Priority,
    /// Minimum width needed to show this zone.
    pub min_width: usize,
    /// Current allocated width.
    pub allocated: usize,
    /// Whether zone is currently visible.
    pub visible: bool,
}

impl PriorityZone {
    /// Create a new priority zone.
    pub fn new(id: impl Into<String>, priority: Priority, min_width: usize) -> Self {
        Self {
            id: id.into(),
            priority,
            min_width,
            allocated: 0,
            visible: false,
        }
    }
}

/// Allocate space to zones based on priority.
///
/// Higher priority zones are allocated first. Zones that don't fit
/// are marked as not visible.
///
/// # Example
/// ```
/// use composer_tui::layout_constraints::{allocate_priority_zones, PriorityZone, Priority};
///
/// let mut zones = vec![
///     PriorityZone::new("essential", Priority::Essential, 20),
///     PriorityZone::new("normal", Priority::Normal, 30),
///     PriorityZone::new("optional", Priority::Low, 25),
/// ];
///
/// allocate_priority_zones(&mut zones, 60, 2);
/// // Available: 60, gaps: 4 (2 gaps between 3 zones)
/// // Essential (20) + Normal (30) = 50, fits with gaps
/// // Optional won't fit (50 + 4 + 25 = 79 > 60)
///
/// assert!(zones.iter().find(|z| z.id == "essential").unwrap().visible);
/// assert!(zones.iter().find(|z| z.id == "normal").unwrap().visible);
/// assert!(!zones.iter().find(|z| z.id == "optional").unwrap().visible);
/// ```
pub fn allocate_priority_zones(zones: &mut [PriorityZone], available: usize, gap: usize) {
    // Reset all zones
    for zone in zones.iter_mut() {
        zone.allocated = 0;
        zone.visible = false;
    }

    // Sort by priority (highest first)
    let mut indices: Vec<usize> = (0..zones.len()).collect();
    indices.sort_by(|&a, &b| zones[b].priority.cmp(&zones[a].priority));

    let mut used = 0;
    let mut visible_count = 0;

    for &idx in &indices {
        let zone = &zones[idx];
        let gap_needed = if visible_count > 0 { gap } else { 0 };
        let total_needed = used + gap_needed + zone.min_width;

        if total_needed <= available {
            used = total_needed;
            visible_count += 1;
            zones[idx].allocated = zone.min_width;
            zones[idx].visible = true;
        }
    }

    // Distribute remaining space to visible zones (highest priority first)
    let mut remaining = available.saturating_sub(used);
    for &idx in &indices {
        if remaining == 0 {
            break;
        }
        if zones[idx].visible {
            // Give extra space to this zone
            zones[idx].allocated += remaining;
            remaining = 0;
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PANEL WIDTH PRESETS
// ─────────────────────────────────────────────────────────────────────────────

/// Common panel width presets.
pub mod presets {
    /// Standard panel widths used across the UI.
    pub struct PanelWidths;

    impl PanelWidths {
        /// Tool panel width.
        pub const TOOL: usize = 60;
        /// Welcome panel width.
        pub const WELCOME: usize = 56;
        /// About panel width.
        pub const ABOUT: usize = 60;
        /// Minimum user message width.
        pub const USER_MESSAGE_MIN: usize = 36;
        /// Maximum user message width.
        pub const USER_MESSAGE_MAX: usize = 72;
        /// Minimum shell block width.
        pub const SHELL_BLOCK_MIN: usize = 42;
        /// Maximum shell block width.
        pub const SHELL_BLOCK_MAX: usize = 80;
        /// Table column width.
        pub const TABLE_COLUMN: usize = 40;
    }

    /// Display limits for various elements.
    pub struct DisplayLimits;

    impl DisplayLimits {
        /// Maximum items in selector lists.
        pub const SELECTOR_ITEMS: usize = 10;
        /// Maximum streaming output lines.
        pub const STREAMING_OUTPUT_LINES: usize = 20;
        /// Maximum context items to show.
        pub const CONTEXT_ITEMS: usize = 15;
        /// Maximum inline code preview length.
        pub const INLINE_CODE_PREVIEW: usize = 100;
    }

    /// Standard spacing values.
    pub struct StandardSpacing;

    impl StandardSpacing {
        /// Horizontal padding.
        pub const PADDING_X: usize = 1;
        /// Vertical padding.
        pub const PADDING_Y: usize = 1;
        /// Standard indentation.
        pub const INDENT: usize = 2;
        /// Code block indentation.
        pub const CODE_INDENT: usize = 2;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ZONE LAYOUT BUILDER
// ─────────────────────────────────────────────────────────────────────────────

/// Builder for creating multi-zone layouts.
#[derive(Debug, Default)]
pub struct ZoneLayout {
    zones: HashMap<String, ZoneConfig>,
    order: Vec<String>,
    gap: usize,
}

/// Configuration for a layout zone.
#[derive(Debug, Clone)]
pub struct ZoneConfig {
    /// Minimum width percentage (0.0 - 1.0).
    pub min_percent: f32,
    /// Maximum width percentage (0.0 - 1.0).
    pub max_percent: f32,
    /// Absolute minimum width in columns.
    pub min_width: usize,
    /// Priority for space allocation.
    pub priority: Priority,
}

impl Default for ZoneConfig {
    fn default() -> Self {
        Self {
            min_percent: 0.0,
            max_percent: 1.0,
            min_width: 1,
            priority: Priority::Normal,
        }
    }
}

impl ZoneLayout {
    /// Create a new zone layout.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Set gap between zones.
    #[must_use]
    pub fn gap(mut self, gap: usize) -> Self {
        self.gap = gap;
        self
    }

    /// Add a zone with configuration.
    pub fn zone(mut self, id: impl Into<String>, config: ZoneConfig) -> Self {
        let id = id.into();
        self.order.push(id.clone());
        self.zones.insert(id, config);
        self
    }

    /// Calculate zone widths for a given total width.
    #[must_use]
    pub fn calculate(&self, total_width: usize) -> HashMap<String, usize> {
        let mut result = HashMap::new();

        if self.order.is_empty() {
            return result;
        }

        // Calculate available width after gaps
        let gap_total = self.gap * self.order.len().saturating_sub(1);
        let available = total_width.saturating_sub(gap_total);

        // First pass: assign minimum widths
        let mut assigned: HashMap<String, usize> = HashMap::new();
        let mut remaining = available;

        for id in &self.order {
            if let Some(config) = self.zones.get(id) {
                let min = config
                    .min_width
                    .max((available as f32 * config.min_percent) as usize);
                let width = min.min(remaining);
                assigned.insert(id.clone(), width);
                remaining = remaining.saturating_sub(width);
            }
        }

        // Second pass: distribute remaining by priority
        if remaining > 0 {
            let mut by_priority: Vec<_> = self
                .order
                .iter()
                .filter_map(|id| self.zones.get(id).map(|c| (id.clone(), c)))
                .collect();
            by_priority.sort_by(|a, b| b.1.priority.cmp(&a.1.priority));

            for (id, config) in by_priority {
                if remaining == 0 {
                    break;
                }
                let current = *assigned.get(&id).unwrap_or(&0);
                let max = (available as f32 * config.max_percent) as usize;
                let can_add = max.saturating_sub(current);
                let add = can_add.min(remaining);
                *assigned.entry(id).or_insert(0) += add;
                remaining = remaining.saturating_sub(add);
            }
        }

        result = assigned;
        result
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spacing_calculations() {
        let spacing = Spacing { x: 2, y: 1 };
        assert_eq!(spacing.total_x(), 4);
        assert_eq!(spacing.total_y(), 2);
    }

    #[test]
    fn constraints_clamp() {
        let constraints = LayoutConstraints::width(20, 80);
        assert_eq!(constraints.clamp_width(10), 20);
        assert_eq!(constraints.clamp_width(50), 50);
        assert_eq!(constraints.clamp_width(100), 80);
    }

    #[test]
    fn responsive_width_calculation() {
        // Within bounds
        assert_eq!(responsive_width(100, 20, 80, 0.5), 50);

        // Below minimum
        assert_eq!(responsive_width(30, 20, 80, 0.5), 20);

        // Above maximum
        assert_eq!(responsive_width(200, 20, 80, 0.5), 80);
    }

    #[test]
    fn content_width_with_borders() {
        // With borders: 4 for borders + 2*padding
        assert_eq!(content_width(80, true, 1), 74);

        // Without borders: just padding
        assert_eq!(content_width(80, false, 1), 78);
    }

    #[test]
    fn flex_distribution_equal_weights() {
        let items = vec![
            FlexItem::weight(1.0),
            FlexItem::weight(1.0),
            FlexItem::weight(1.0),
        ];
        let widths = distribute_flex(100, &items, 2);
        // Available: 100 - 4 (gaps) = 96, divided by 3 = 32 each
        assert_eq!(widths, vec![32, 32, 32]);
    }

    #[test]
    fn flex_distribution_unequal_weights() {
        let items = vec![FlexItem::weight(1.0), FlexItem::weight(3.0)];
        let widths = distribute_flex(100, &items, 0);
        // 1:3 ratio of 100 = 25:75
        assert_eq!(widths, vec![25, 75]);
    }

    #[test]
    fn flex_distribution_with_constraints() {
        let items = vec![FlexItem::weight(1.0).min(30), FlexItem::weight(1.0).max(20)];
        let widths = distribute_flex(100, &items, 0);
        // Equal weights would be 50:50, but max constraint limits second
        // First gets 30 (min), second gets 20 (max), remainder distributed
        assert!(widths[0] >= 30);
        assert!(widths[1] <= 20);
    }

    #[test]
    fn flex_fixed_items() {
        let items = vec![
            FlexItem::fixed(20),
            FlexItem::weight(1.0),
            FlexItem::fixed(20),
        ];
        let widths = distribute_flex(100, &items, 0);
        // Fixed items get their width, remainder to weighted
        assert_eq!(widths[0], 20);
        assert_eq!(widths[2], 20);
        assert_eq!(widths[1], 60);
    }

    #[test]
    fn breakpoint_detection() {
        assert_eq!(Breakpoint::from_width(30), Breakpoint::Narrow);
        assert_eq!(Breakpoint::from_width(50), Breakpoint::Compact);
        assert_eq!(Breakpoint::from_width(70), Breakpoint::Medium);
        assert_eq!(Breakpoint::from_width(100), Breakpoint::Standard);
        assert_eq!(Breakpoint::from_width(150), Breakpoint::Wide);
    }

    #[test]
    fn priority_zone_allocation() {
        let mut zones = vec![
            PriorityZone::new("low", Priority::Low, 20),
            PriorityZone::new("essential", Priority::Essential, 30),
            PriorityZone::new("normal", Priority::Normal, 25),
        ];

        allocate_priority_zones(&mut zones, 70, 2);

        // Essential (30) and Normal (25) should fit: 30 + 2 + 25 = 57
        // Low (20) won't fit: 57 + 2 + 20 = 79 > 70
        let essential = zones.iter().find(|z| z.id == "essential").unwrap();
        let normal = zones.iter().find(|z| z.id == "normal").unwrap();
        let low = zones.iter().find(|z| z.id == "low").unwrap();

        assert!(essential.visible);
        assert!(normal.visible);
        assert!(!low.visible);
    }

    #[test]
    fn zone_layout_calculation() {
        let layout = ZoneLayout::new()
            .gap(2)
            .zone(
                "left",
                ZoneConfig {
                    min_percent: 0.2,
                    max_percent: 0.3,
                    min_width: 10,
                    priority: Priority::Normal,
                },
            )
            .zone(
                "center",
                ZoneConfig {
                    min_percent: 0.4,
                    max_percent: 0.6,
                    min_width: 20,
                    priority: Priority::High,
                },
            )
            .zone(
                "right",
                ZoneConfig {
                    min_percent: 0.2,
                    max_percent: 0.3,
                    min_width: 10,
                    priority: Priority::Normal,
                },
            );

        let widths = layout.calculate(100);

        // All zones should get some width
        assert!(widths.get("left").unwrap_or(&0) >= &10);
        assert!(widths.get("center").unwrap_or(&0) >= &20);
        assert!(widths.get("right").unwrap_or(&0) >= &10);
    }

    #[test]
    fn presets_accessible() {
        assert_eq!(presets::PanelWidths::TOOL, 60);
        assert_eq!(presets::DisplayLimits::SELECTOR_ITEMS, 10);
        assert_eq!(presets::StandardSpacing::INDENT, 2);
    }
}
