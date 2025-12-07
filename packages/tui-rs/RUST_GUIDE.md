# Rust Quick Reference for Composer TUI

This guide explains Rust concepts you'll encounter in the Composer TUI codebase. It's designed for team members coming from TypeScript/JavaScript backgrounds.

## Table of Contents

1. [Key Differences from TypeScript](#key-differences-from-typescript)
2. [Ownership and Borrowing](#ownership-and-borrowing)
3. [Common Patterns](#common-patterns)
4. [Error Handling](#error-handling)
5. [Async/Await](#asyncawait)
6. [Traits (Interfaces)](#traits-interfaces)
7. [Enums and Pattern Matching](#enums-and-pattern-matching)
8. [The Module System](#the-module-system)
9. [Common Types](#common-types)
10. [Useful Commands](#useful-commands)

---

## Key Differences from TypeScript

| TypeScript | Rust | Notes |
|------------|------|-------|
| `null` / `undefined` | `Option<T>` | Rust has no null - use `Option::Some(value)` or `Option::None` |
| `throw new Error()` | `Result<T, E>` | Errors are return values, not exceptions |
| `interface` | `trait` | Traits define shared behavior |
| `class` | `struct` + `impl` | Data and methods are separate |
| `const x = "hi"` | `let x = "hi"` | `let` in Rust is like `const` in TS |
| `let x = "hi"` | `let mut x = "hi"` | Need `mut` to modify a variable |
| `import { x } from './foo'` | `use crate::foo::x` | Different module system |
| `string` | `String` or `&str` | Two string types (see below) |

---

## Ownership and Borrowing

This is Rust's most unique feature. It prevents memory bugs at compile time.

### The Three Rules

1. Each value has exactly one **owner**
2. When the owner goes out of scope, the value is dropped (freed)
3. You can **borrow** a value (create a reference) without taking ownership

### Example

```rust
// OWNERSHIP
let s1 = String::from("hello");  // s1 owns the string
let s2 = s1;                      // Ownership MOVES to s2
// println!("{}", s1);            // ERROR: s1 no longer valid

// BORROWING (references)
let s1 = String::from("hello");
let len = calculate_length(&s1);  // Borrow s1 (don't take ownership)
println!("{}", s1);               // s1 is still valid!

fn calculate_length(s: &String) -> usize {  // &String = borrowed reference
    s.len()
}
```

### Quick Reference

| Syntax | Meaning |
|--------|---------|
| `T` | Owned value - function takes ownership |
| `&T` | Shared reference - read-only borrow |
| `&mut T` | Mutable reference - read-write borrow |

---

## Common Patterns

### String Types

```rust
// &str - borrowed string slice (like a view)
// - Use for function parameters when you only need to read
let greeting: &str = "hello";  // String literals are &str

// String - owned, heap-allocated string
// - Use when you need to own or modify the string
let mut name = String::from("Alice");
name.push_str(" Smith");

// Converting between them
let s: String = "hello".to_string();  // &str -> String
let r: &str = &s;                      // String -> &str (borrowing)
```

### Option<T> - Nullable Values

```rust
// Instead of null, Rust uses Option
let maybe_name: Option<String> = Some("Alice".to_string());
let no_name: Option<String> = None;

// You MUST handle both cases
match maybe_name {
    Some(name) => println!("Hello, {}", name),
    None => println!("Hello, stranger"),
}

// Common shortcuts
let name = maybe_name.unwrap();           // Panics if None!
let name = maybe_name.unwrap_or("default".to_string());
let name = maybe_name.unwrap_or_else(|| generate_name());

// Transform the value inside
let upper = maybe_name.map(|n| n.to_uppercase());  // Option<String>

// Chain operations
let result = maybe_name
    .as_ref()           // Option<&String> (borrow instead of move)
    .map(|s| s.len())   // Option<usize>
    .unwrap_or(0);      // usize
```

### if let - Conditional Matching

```rust
// Instead of:
match maybe_value {
    Some(v) => do_something(v),
    None => {},
}

// Use:
if let Some(v) = maybe_value {
    do_something(v);
}
```

---

## Error Handling

Rust uses `Result<T, E>` for operations that can fail.

```rust
// Result has two variants
enum Result<T, E> {
    Ok(T),    // Success with value
    Err(E),   // Failure with error
}

// Example function that can fail
fn read_file(path: &str) -> Result<String, std::io::Error> {
    std::fs::read_to_string(path)
}

// Handling results
match read_file("config.toml") {
    Ok(content) => println!("File: {}", content),
    Err(e) => eprintln!("Error: {}", e),
}

// The ? operator - propagate errors
fn load_config() -> Result<Config, Error> {
    let content = read_file("config.toml")?;  // Returns early if Err
    let config = parse_config(&content)?;
    Ok(config)
}

// anyhow - simplified error handling (used in this codebase)
use anyhow::Result;

fn do_something() -> Result<()> {
    let x = might_fail()?;  // ? works with any error type
    Ok(())
}
```

---

## Async/Await

Very similar to TypeScript, but with some differences.

```rust
// Define an async function
async fn fetch_data() -> Result<Data> {
    let response = client.get(url).await?;  // .await goes AFTER
    let data = response.json().await?;
    Ok(data)
}

// Call async functions
async fn main() {
    let data = fetch_data().await;  // Must .await to get the value
}

// Spawn concurrent tasks
let handle1 = tokio::spawn(async { fetch_data().await });
let handle2 = tokio::spawn(async { fetch_more_data().await });

let (result1, result2) = tokio::join!(handle1, handle2);
```

---

## Traits (Interfaces)

Traits define shared behavior, like TypeScript interfaces.

```rust
// Define a trait
trait Greet {
    fn greet(&self) -> String;

    // Default implementation (optional)
    fn greeting_with_name(&self, name: &str) -> String {
        format!("{}, {}!", self.greet(), name)
    }
}

// Implement for a type
struct EnglishGreeter;

impl Greet for EnglishGreeter {
    fn greet(&self) -> String {
        "Hello".to_string()
    }
}

// Use in function signatures
fn say_hello(greeter: &impl Greet) {
    println!("{}", greeter.greet());
}

// Common standard library traits
// - Clone: .clone() creates a copy
// - Debug: {:?} formatting
// - Default: default() creates a default value
// - PartialEq: == comparison
// - Serialize/Deserialize: serde JSON/TOML conversion
```

---

## Enums and Pattern Matching

Rust enums are much more powerful than TypeScript enums.

```rust
// Enums can hold data
enum Message {
    Quit,                       // No data
    Move { x: i32, y: i32 },    // Named fields
    Write(String),              // Unnamed data
    Color(u8, u8, u8),          // Multiple values
}

// Pattern matching
fn process(msg: Message) {
    match msg {
        Message::Quit => println!("Quitting"),
        Message::Move { x, y } => println!("Move to {}, {}", x, y),
        Message::Write(text) => println!("Text: {}", text),
        Message::Color(r, g, b) => println!("RGB: {}, {}, {}", r, g, b),
    }
}

// Match is exhaustive - must handle ALL cases
// Use _ for catch-all
match value {
    1 => println!("one"),
    2 => println!("two"),
    _ => println!("other"),  // Everything else
}
```

---

## The Module System

### File Structure

```
src/
├── main.rs          # Binary entry point
├── lib.rs           # Library root (defines modules)
├── config.rs        # Module file
├── state.rs         # Module file
└── components/      # Directory module
    ├── mod.rs       # Module root (or components.rs in parent)
    └── button.rs    # Submodule
```

### Visibility

```rust
// In lib.rs
pub mod config;           // Public module (accessible outside crate)
mod internal;             // Private module (crate only)

// In config.rs
pub struct Config { }     // Public struct
pub fn load() { }         // Public function
fn helper() { }           // Private function (module only)

// Importing
use crate::config::Config;        // From crate root
use super::helper;                 // From parent module
use self::submodule::Thing;        // From current module
```

---

## Common Types

| Type | Description | TypeScript Equivalent |
|------|-------------|----------------------|
| `i32`, `i64` | Signed integers | `number` |
| `u32`, `u64`, `usize` | Unsigned integers | `number` |
| `f32`, `f64` | Floating point | `number` |
| `bool` | Boolean | `boolean` |
| `char` | Single Unicode character | N/A |
| `String` | Owned string | `string` |
| `&str` | String slice | `string` (roughly) |
| `Vec<T>` | Growable array | `T[]` |
| `HashMap<K, V>` | Hash map | `Map<K, V>` or `{[key: K]: V}` |
| `Option<T>` | Nullable | `T \| null` |
| `Result<T, E>` | Fallible | `T` (with throw) |
| `Box<T>` | Heap-allocated | N/A (all heap in JS) |
| `Arc<T>` | Thread-safe reference counted | N/A |
| `Mutex<T>` | Thread-safe mutable | N/A |

---

## Useful Commands

```bash
# Building
cargo build              # Debug build
cargo build --release    # Optimized build
cargo check              # Type check without building (faster)

# Running
cargo run                # Build and run
cargo run -- args        # Pass arguments to the binary

# Testing
cargo test               # Run all tests
cargo test test_name     # Run specific test
cargo test -- --nocapture  # Show println! output

# Other
cargo fmt                # Format code
cargo clippy             # Lint code (find issues)
cargo doc --open         # Generate and view documentation
```

---

## Further Reading

- [The Rust Book](https://doc.rust-lang.org/book/) - The official guide
- [Rust by Example](https://doc.rust-lang.org/rust-by-example/) - Learn through examples
- [Rustlings](https://github.com/rust-lang/rustlings) - Small exercises
