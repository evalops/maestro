//! Headless protocol for communicating with the Node.js agent
//!
//! This module implements the client side of the headless protocol,
//! spawning the Node.js agent and communicating via JSON-over-stdio.

mod messages;
mod transport;

pub use messages::*;
pub use transport::*;
