//! Render tree types
//!
//! Defines the component tree structure sent from TypeScript for rendering.

use serde::{Deserialize, Serialize};

use super::{StyledSpan, TextStyle};

/// A node in the render tree
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RenderNode {
    /// Plain text content
    Text {
        content: String,
        #[serde(default)]
        style: TextStyle,
    },

    /// Styled text with multiple spans
    StyledText { spans: Vec<StyledSpan> },

    /// Vertical layout container
    Column {
        children: Vec<RenderNode>,
        #[serde(default)]
        gap: u16,
    },

    /// Horizontal layout container
    Row {
        children: Vec<RenderNode>,
        #[serde(default)]
        gap: u16,
    },

    /// Box with optional border
    Box {
        child: Option<std::boxed::Box<RenderNode>>,
        #[serde(default)]
        border: BorderStyle,
        #[serde(default)]
        padding: Padding,
        #[serde(default)]
        title: Option<String>,
    },

    /// Scrollable container
    Scroll {
        child: std::boxed::Box<RenderNode>,
        /// Current scroll offset
        offset: u16,
        /// Total content height (for scrollbar)
        content_height: u16,
        /// Show scrollbar indicator
        #[serde(default)]
        show_scrollbar: bool,
    },

    /// Text input field
    Input {
        /// Current input value
        value: String,
        /// Cursor position within value
        cursor: usize,
        /// Placeholder text
        #[serde(default)]
        placeholder: Option<String>,
        /// Is input focused
        #[serde(default)]
        focused: bool,
    },

    /// Multi-line text editor
    Editor {
        /// Lines of text
        lines: Vec<String>,
        /// Cursor position (line, column)
        cursor: (usize, usize),
        /// Is editor focused
        #[serde(default)]
        focused: bool,
        /// Scroll offset (line)
        #[serde(default)]
        scroll_offset: usize,
    },

    /// Markdown rendered content
    Markdown {
        /// Pre-rendered lines with styling
        lines: Vec<Vec<StyledSpan>>,
    },

    /// Selection list
    SelectList {
        items: Vec<SelectItem>,
        selected: usize,
        #[serde(default)]
        scroll_offset: usize,
    },

    /// Status bar
    StatusBar {
        left: Vec<StatusItem>,
        #[serde(default)]
        center: Vec<StatusItem>,
        #[serde(default)]
        right: Vec<StatusItem>,
    },

    /// Spacer (flexible or fixed)
    Spacer {
        #[serde(default)]
        size: Option<u16>,
    },

    /// Empty node (renders nothing)
    Empty,
}

/// Border style for boxes
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BorderStyle {
    #[default]
    None,
    Single,
    Double,
    Rounded,
    Heavy,
}

/// Padding for boxes
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Padding {
    #[serde(default)]
    pub top: u16,
    #[serde(default)]
    pub right: u16,
    #[serde(default)]
    pub bottom: u16,
    #[serde(default)]
    pub left: u16,
}

impl Padding {
    pub fn all(value: u16) -> Self {
        Self {
            top: value,
            right: value,
            bottom: value,
            left: value,
        }
    }

    pub fn horizontal(value: u16) -> Self {
        Self {
            left: value,
            right: value,
            ..Default::default()
        }
    }

    pub fn vertical(value: u16) -> Self {
        Self {
            top: value,
            bottom: value,
            ..Default::default()
        }
    }
}

/// An item in a selection list
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectItem {
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub hint: Option<String>,
    #[serde(default)]
    pub disabled: bool,
}

/// An item in a status bar
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusItem {
    pub content: String,
    #[serde(default)]
    pub style: TextStyle,
}

impl RenderNode {
    /// Create a text node
    pub fn text(content: impl Into<String>) -> Self {
        Self::Text {
            content: content.into(),
            style: TextStyle::default(),
        }
    }

    /// Create a column layout
    pub fn column(children: Vec<RenderNode>) -> Self {
        Self::Column { children, gap: 0 }
    }

    /// Create a row layout
    pub fn row(children: Vec<RenderNode>) -> Self {
        Self::Row { children, gap: 0 }
    }

    /// Create a box with border
    pub fn bordered(child: RenderNode) -> Self {
        Self::Box {
            child: Some(std::boxed::Box::new(child)),
            border: BorderStyle::Single,
            padding: Padding::default(),
            title: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_render_node_text() {
        let json = r#"{"type":"text","content":"Hello, World!"}"#;
        let node: RenderNode = serde_json::from_str(json).unwrap();
        assert!(matches!(node, RenderNode::Text { content, .. } if content == "Hello, World!"));
    }

    #[test]
    fn test_render_node_column() {
        let json = r#"{
            "type": "column",
            "children": [
                {"type": "text", "content": "Line 1"},
                {"type": "text", "content": "Line 2"}
            ]
        }"#;
        let node: RenderNode = serde_json::from_str(json).unwrap();
        assert!(matches!(node, RenderNode::Column { children, .. } if children.len() == 2));
    }

    #[test]
    fn test_render_node_box_with_border() {
        let json = r#"{
            "type": "box",
            "child": {"type": "text", "content": "Inside"},
            "border": "rounded",
            "title": "My Box"
        }"#;
        let node: RenderNode = serde_json::from_str(json).unwrap();
        assert!(matches!(
            node,
            RenderNode::Box {
                border: BorderStyle::Rounded,
                title: Some(t),
                ..
            } if t == "My Box"
        ));
    }
}
