//! Headless component rendering; no terminal session or agent runtime.
use maestro_ui_preview::{Scene, ansi, catalog, render};
fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let mut scene = Scene {
        id: "startup".into(),
        label: String::new(),
        width: 100,
        height: 10,
        time_ms: 0,
    };
    let mut list = false;
    let mut identity = false;
    while let Some(arg) = args.next() {
        if arg == "--identity" {
            identity = true;
            continue;
        }
        if arg == "--list" {
            list = true;
            continue;
        }
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {arg}"))?;
        match arg.as_str() {
            "--scene" => scene.id = value,
            "--width" => scene.width = value.parse().map_err(|_| "invalid width")?,
            "--height" => scene.height = value.parse().map_err(|_| "invalid height")?,
            "--time-ms" => scene.time_ms = value.parse().map_err(|_| "invalid time-ms")?,
            _ => return Err(format!("unknown argument: {arg}")),
        }
    }
    if identity {
        println!("{}", env!("MAESTRO_PREVIEW_SOURCE_DIGEST"));
    } else if list {
        println!(
            "{}",
            serde_json::to_string_pretty(&catalog()).map_err(|e| e.to_string())?
        );
    } else {
        print!("{}", ansi(&render(&scene)?));
    }
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(2);
    }
}
