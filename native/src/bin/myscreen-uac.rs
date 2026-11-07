#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
#[path = "uac/broker.rs"]
mod broker;
#[cfg(windows)]
#[path = "uac/desktop.rs"]
mod desktop;
#[cfg(windows)]
#[path = "uac/video.rs"]
mod video;

#[cfg(windows)]
fn main() {
    if let Err(error) = broker::run() {
        eprintln!("MyScreen UAC: {error}");
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {}
