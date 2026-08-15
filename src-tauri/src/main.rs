// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Cap the global Rayon thread pool so background vault indexing / embedding
    // work never swarms every CPU core (keeps system CPU usage at 1%–3%).
    rayon::ThreadPoolBuilder::new().num_threads(2).build_global().ok();
    app_lib::run();
}
