//! Jupyter notebook editing utilities.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::agent::ToolResult;
use crate::safety::{require_plan, run_validators};

#[derive(Debug, Deserialize)]
struct NotebookEditArgs {
    path: String,
    #[serde(default, alias = "cellId", alias = "cell_id")]
    cell_id: Option<String>,
    #[serde(default, alias = "cellIndex", alias = "cell_index")]
    cell_index: Option<usize>,
    #[serde(default, alias = "newSource", alias = "new_source")]
    new_source: String,
    #[serde(default, alias = "cellType", alias = "cell_type")]
    cell_type: Option<String>,
    #[serde(default, alias = "editMode", alias = "edit_mode")]
    edit_mode: Option<String>,
}

fn source_to_array(source: &str) -> Vec<Value> {
    let mut lines = source
        .split_inclusive('\n')
        .map(|line| Value::String(line.to_string()))
        .collect::<Vec<_>>();
    if lines.is_empty() {
        lines.push(Value::String(String::new()));
    }
    lines
}

fn generate_cell_id() -> String {
    let id = uuid::Uuid::new_v4().to_string();
    id.split('-').next().unwrap_or(&id).to_string()
}

fn find_cell_index(
    cells: &[Value],
    cell_id: Option<&str>,
    cell_index: Option<usize>,
) -> Result<isize, String> {
    if let Some(id) = cell_id {
        let idx = cells.iter().position(|cell| {
            cell.get("id")
                .and_then(|v| v.as_str())
                .is_some_and(|s| s == id)
        });
        return idx
            .map(|v| v as isize)
            .ok_or_else(|| format!("Cell with ID \"{id}\" not found"));
    }
    if let Some(idx) = cell_index {
        if idx >= cells.len() {
            return Err(format!(
                "Cell index {} out of range (notebook has {} cells)",
                idx,
                cells.len()
            ));
        }
        return Ok(idx as isize);
    }
    Ok(-1)
}

fn build_cell(cell_type: &str, source: &str) -> Value {
    let mut cell = serde_json::Map::new();
    cell.insert("id".to_string(), Value::String(generate_cell_id()));
    cell.insert(
        "cell_type".to_string(),
        Value::String(cell_type.to_string()),
    );
    cell.insert("source".to_string(), Value::Array(source_to_array(source)));
    cell.insert(
        "metadata".to_string(),
        Value::Object(serde_json::Map::new()),
    );
    if cell_type == "code" {
        cell.insert("execution_count".to_string(), Value::Null);
        cell.insert("outputs".to_string(), Value::Array(Vec::new()));
    }
    Value::Object(cell)
}

pub async fn notebook_edit(raw_args: Value, cwd: &str) -> ToolResult {
    let parsed: NotebookEditArgs = match serde_json::from_value(raw_args) {
        Ok(val) => val,
        Err(err) => return ToolResult::failure(format!("Invalid notebook_edit args: {err}")),
    };

    let edit_mode = parsed.edit_mode.unwrap_or_else(|| "replace".to_string());

    if let Err(err) = require_plan("notebook_edit") {
        return ToolResult::failure(err);
    }

    let path = {
        let raw = parsed.path.trim();
        if raw.is_empty() {
            return ToolResult::failure("Missing path argument".to_string());
        }
        if std::path::Path::new(raw).is_absolute() {
            raw.to_string()
        } else {
            std::path::Path::new(cwd)
                .join(raw)
                .to_string_lossy()
                .to_string()
        }
    };

    if !path.to_lowercase().ends_with(".ipynb") {
        return ToolResult::failure(format!("File must be a Jupyter notebook (.ipynb): {path}"));
    }

    let path_buf = std::path::PathBuf::from(&path);

    // If file doesn't exist and insert without target, create new notebook
    if !path_buf.exists()
        && edit_mode == "insert"
        && parsed.cell_id.is_none()
        && parsed.cell_index.is_none()
    {
        let cell_type = parsed.cell_type.unwrap_or_else(|| "code".to_string());
        let notebook = json!({
            "cells": [build_cell(&cell_type, &parsed.new_source)],
            "metadata": {
                "kernelspec": {
                    "display_name": "Python 3",
                    "language": "python",
                    "name": "python3"
                }
            },
            "nbformat": 4,
            "nbformat_minor": 5
        });
        if let Some(parent) = path_buf.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        if let Err(err) =
            tokio::fs::write(&path_buf, serde_json::to_string_pretty(&notebook).unwrap()).await
        {
            return ToolResult::failure(format!("Failed to write notebook: {err}"));
        }

        let details = json!({
            "cellIndex": 0,
            "mode": "create",
            "totalCells": 1
        });
        return ToolResult::success(format!(
            "Created new notebook with 1 {cell_type} cell: {path}"
        ))
        .with_details(details);
    }

    let content = match tokio::fs::read_to_string(&path_buf).await {
        Ok(text) => text,
        Err(err) => {
            return ToolResult::failure(format!("Failed to read notebook: {err}"));
        }
    };

    let mut notebook: Value = match serde_json::from_str(&content) {
        Ok(val) => val,
        Err(err) => return ToolResult::failure(format!("Failed to parse notebook: {err}")),
    };

    let cells = notebook
        .get_mut("cells")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| ToolResult::failure("Invalid notebook format: missing cells".to_string()));

    let cells = match cells {
        Ok(val) => val,
        Err(err) => return err,
    };

    let target_index = match find_cell_index(cells, parsed.cell_id.as_deref(), parsed.cell_index) {
        Ok(idx) => idx,
        Err(err) => return ToolResult::failure(err),
    };

    let (result_cell_id, mode) = match edit_mode.as_str() {
        "replace" => {
            if target_index < 0 {
                return ToolResult::failure(
                    "Must specify cell_id or cell_index for replace mode".to_string(),
                );
            }
            let idx = target_index as usize;
            let existing_type = cells[idx]
                .get("cell_type")
                .and_then(|v| v.as_str())
                .unwrap_or("code");
            let cell_type = parsed
                .cell_type
                .clone()
                .unwrap_or_else(|| existing_type.to_string());
            let mut new_cell = cells[idx].clone();
            if let Some(obj) = new_cell.as_object_mut() {
                obj.insert("cell_type".to_string(), Value::String(cell_type));
                obj.insert(
                    "source".to_string(),
                    Value::Array(source_to_array(&parsed.new_source)),
                );
            }
            let result_cell_id = new_cell
                .get("id")
                .and_then(|v| v.as_str())
                .map(std::string::ToString::to_string);
            cells[idx] = new_cell;
            (result_cell_id, "replace")
        }
        "insert" => {
            let cell_type = parsed
                .cell_type
                .clone()
                .unwrap_or_else(|| "code".to_string());
            let new_cell = build_cell(&cell_type, &parsed.new_source);
            let insert_at = if target_index < 0 {
                0
            } else {
                (target_index as usize) + 1
            };
            cells.insert(insert_at, new_cell.clone());
            let result_cell_id = new_cell
                .get("id")
                .and_then(|v| v.as_str())
                .map(std::string::ToString::to_string);
            (result_cell_id, "insert")
        }
        "delete" => {
            if target_index < 0 {
                return ToolResult::failure(
                    "Must specify cell_id or cell_index for delete mode".to_string(),
                );
            }
            let idx = target_index as usize;
            if idx >= cells.len() {
                return ToolResult::failure("Cell index out of range".to_string());
            }
            let removed = cells.remove(idx);
            let result_cell_id = removed
                .get("id")
                .and_then(|v| v.as_str())
                .map(std::string::ToString::to_string);
            (result_cell_id, "delete")
        }
        _ => {
            return ToolResult::failure(
                "Invalid edit_mode (use replace, insert, delete)".to_string(),
            );
        }
    };

    let total_cells = cells.len();

    let updated = serde_json::to_string_pretty(&notebook).unwrap_or_else(|_| content.clone());
    if let Err(err) = tokio::fs::write(&path_buf, updated).await {
        return ToolResult::failure(format!("Failed to write notebook: {err}"));
    }

    if let Err(err) = run_validators(std::slice::from_ref(&path)).await {
        return ToolResult::failure(err);
    }

    let details = json!({
        "cellIndex": if target_index < 0 { 0 } else { target_index },
        "cellId": result_cell_id,
        "mode": mode,
        "totalCells": total_cells
    });

    ToolResult::success(format!(
        "Notebook updated ({mode}). Total cells: {total_cells}"
    ))
    .with_details(details)
}
