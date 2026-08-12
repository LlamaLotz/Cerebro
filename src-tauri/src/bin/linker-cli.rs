use std::env;
use std::fs;
use std::process;
fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        eprintln!("Usage: linker-cli <command> <file>");
        eprintln!("Commands: scan, diff, apply");
        process::exit(1);
    }

    let command = &args[1];
    let file_path = &args[2];

    // For testing, we use a fixed dictionary and db path
    let dict_path = "test-dictionary.json";
    let db_path = "linker_test.db";

    let dict_content = fs::read_to_string(dict_path)
        .expect("Could not read test-dictionary.json");
    let dict_json: serde_json::Value = serde_json::from_str(&dict_content)
        .expect("Invalid JSON in test-dictionary.json");
    
    let mut patterns = Vec::new();
    if let Some(obj) = dict_json.as_object() {
        for key in obj.keys() {
            patterns.push(key.clone());
        }
    }

    let mut engine = app_lib::linker::LinkerEngine::new(db_path, patterns);

    match command.as_str() {
        "scan" => {
            match engine.scan_file(file_path) {
                Ok(links) => println!("Found links: {:?}", links),
                Err(e) => eprintln!("Scan error: {}", e),
            }
        }
        "diff" => {
            match engine.diff_file(file_path) {
                Ok(Some(delta)) => {
                    println!("Added: {:?}", delta.added);
                    println!("Removed: {:?}", delta.removed);
                }
                Ok(None) => println!("No changes detected."),
                Err(e) => eprintln!("Diff error: {}", e),
            }
        }
        "apply" => {
            match engine.apply_file(file_path) {
                Ok(true) => println!("Changes applied successfully."),
                Ok(false) => println!("No changes to apply."),
                Err(e) => eprintln!("Apply error: {}", e),
            }
        }
        _ => {
            eprintln!("Unknown command: {}", command);
            process::exit(1);
        }
    }
}
