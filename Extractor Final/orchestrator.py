import subprocess
import time
import sys
import os

def run_orchestrator(option, source):
    # Path to the master extractor script
    master_script = "/Users/Shiver/Documents/Prism/Extractor Final/master_extractor.py"
    
    # Launch the master extractor
    process = subprocess.Popen(
        [sys.executable, master_script],
        stdin=subprocess.PIPE,
        stdout=sys.stdout,
        stderr=sys.stderr,
        text=True,
        bufsize=0 # Unbuffered
    )

    try:
        # 1. Send the initial option (1 or 2)
        log_msg = f"[Orchestrator] PIPING to master_extractor stdin -> Option: '{option}'"
        print(log_msg)
        process.stdin.write(f"{option}\n")
        process.stdin.flush()

        # 2. Wait 6 seconds
        print("[Orchestrator] Waiting 6 seconds for script readiness...")
        time.sleep(6)

        # 3. Send the source (URL or file path)
        log_msg = f"[Orchestrator] PIPING to master_extractor stdin -> Source: '{source}'"
        print(log_msg)
        process.stdin.write(f"{source}\n")
        process.stdin.flush()

        # Wait for the subprocess to finish
        process.wait()
    except BrokenPipeError:
        print("[Orchestrator] Master extractor closed unexpectedly.")
    finally:
        process.stdin.close()

if __name__ == "__main__":
    if len(sys.argv) >= 2:
        source = sys.argv[1]
        
        # Auto-detect option
        if source.startswith(('http://', 'https://')):
            option = "2"
        elif os.path.exists(source):
            option = "1"
        else:
            print(f"[Orchestrator] ERROR: Source not found or invalid URL: {source}")
            sys.exit(1)
            
        run_orchestrator(option, source)
    else:
        print("Usage: python orchestrator.py <source_url_or_path>")
