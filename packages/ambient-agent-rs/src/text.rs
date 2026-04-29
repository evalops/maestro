//! Shared text formatting helpers for ambient runtime reports.

pub(crate) fn one_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}
