import subprocess
import time
import sys

def run_orchestrator(option, source):
    # Path to the master extractor script
    master_script = "/Users/Shiver/Documents/Cerebro/Extractor Final/master_extractor.py"
    
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
        print(f"[Orchestrator] Sending option: {option}")
        process.stdin.write(f"{option}\n")
        process.stdin.flush()

        # 2. Wait 6 seconds
        print("[Orchestrator] Waiting 6 seconds...")
        time.sleep(6)

        # 3. Send the source (URL or file path)
        print(f"[Orchestrator] Sending source: {source}")
        process.stdin.write(f"{source}\n")
        process.stdin.flush()

        # Wait for the subprocess to finish
        process.wait()
    except BrokenPipeError:
        print("[Orchestrator] Master extractor closed unexpectedly.")
    finally:
        process.stdin.close()

if __name__ == "__main__":
    # Example usage: Orchestrate option '2' (URLs) and provide a URL
    # You would adapt this to be called by Cerebro with appropriate arguments
    # or modify this script to take arguments from the command line.
    
    # Example: python orchestrator.py 2 https://youtube.com/...
    if len(sys.argv) >= 3:
        run_orchestrator(sys.argv[1], sys.argv[2])
    else:
        print("Usage: python orchestrator.py <option> <source>")
