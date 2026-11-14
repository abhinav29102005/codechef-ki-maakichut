#!/usr/bin/env python3
"""
Antigravity Bridge Server for CodeChef Companion
Listens on 127.0.0.1:8765 and connects the browser extension directly to Antigravity CLI (agy).
"""

import sys
sys.dont_write_bytecode = True
import os
import json
import re
import subprocess
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

HOST = "127.0.0.1"
PORT = 8765
AGY_PATH = "/home/bigboyaks/.gemini/bin/agy"
SOLVE_LOCK = threading.Lock()

def clean_code(raw_text):
    if not raw_text:
        return ""
    # Extract code from ```language ... ``` block if present
    match = re.search(r"```(?:[a-zA-Z0-9+#]+)?\s*\n([\s\S]*?)```", raw_text)
    if match:
        return match.group(1).strip()
    return raw_text.strip()

def format_language(lang_code):
    l = (lang_code or "").lower()
    if "cpp" in l or "c++" in l or l == "cc":
        return "C++ (C++20)"
    if "python" in l or l == "py":
        return "Python 3"
    if "java" in l and "javascript" not in l:
        return "Java (Java 17)"
    if "javascript" in l or l == "js" or "typescript" in l:
        return "JavaScript (Node.js)"
    return lang_code or "Python 3"

def build_prompt(problem, language, existing_code=""):
    lang_name = format_language(language)
    samples_str = ""
    samples = problem.get("samples") or []
    for i, s in enumerate(samples):
        samples_str += f"\nSample {i+1} Input:\n{s.get('input', '')}\nSample {i+1} Output:\n{s.get('output', '')}\n"

    existing_section = ""
    if existing_code and existing_code.strip():
        existing_section = f"""
======================================================================
CURRENT CODEBASE / STARTER CODE IN THE STUDENT'S EDITOR:
======================================================================
```{language}
{existing_code.strip()}
```
======================================================================
CRITICAL INSTRUCTIONS FOR CURRENT CODE:
1. The student editor ALREADY contains the starter code / template shown above.
2. Carefully analyze this code!
3. If it has blanks (e.g. '______', '...', TODO, or incomplete expressions):
   - You MUST PRESERVE the existing structure, comments, variables, and all print() statements exactly.
   - ONLY fill in the blanks / missing parts so the code runs without syntax/runtime errors and matches the Expected Output.
   - If there is any duplicate code appended at the bottom from a prior paste, discard the duplicate and only complete the original template cleanly.
4. If the code is already complete, verify it and return the clean, working version.
5. If a dataset like 'customers.csv' is mentioned, read it using pd.read_csv('customers.csv') or as instructed.
======================================================================
"""

    prompt = f"""You are an elite competitive programmer and machine learning engineer solving a CodeChef problem.
Language: {lang_name}
Problem Title: {problem.get('title', '')} ({problem.get('code', '')})
URL: {problem.get('url', '')}

Problem Statement:
{problem.get('statement', '')}

Input Format:
{problem.get('inputFormat', 'Standard Input')}

Output Format:
{problem.get('outputFormat', 'Standard Output')}

Constraints:
{problem.get('constraints', '')}

{samples_str}
{existing_section}
CRITICAL REQUIREMENTS:
1. Provide a 100% correct, bug-free, optimal solution that passes all test cases.
2. If starter code / template was provided in the editor, PRESERVE its exact template, comments, and print() statements, filling in every blank ('_____') so it runs cleanly. Do not invent a new file or write duplicate code.
3. If no starter code was provided, write the clean, self-contained solution from scratch.
4. DISCREPANCY RULE: If the problem description text says e.g. "Map A -> 1, B -> 2" but the "Expected Output" table shows 0, 1, 2 (standard LabelEncoder output), ALWAYS match the "Expected Output" table and use LabelEncoder().fit_transform(...). CodeChef evaluates strictly against the Expected Output!
5. Output ONLY the raw source code inside a single ```{language} ... ``` code block. Absolutely no explanation, conversational prose, or markdown outside the code block.
"""
    return prompt

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

class BridgeHandler(BaseHTTPRequestHandler):
    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def do_OPTIONS(self):
        self.send_response(200)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        self.send_response(200)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        response = {
            "status": "ok",
            "service": "Antigravity CodeChef Bridge",
            "agy_path": AGY_PATH
        }
        self.wfile.write(json.dumps(response).encode("utf-8"))

    def do_POST(self):
        if self.path != "/solve":
            self.send_response(404)
            self._send_cors_headers()
            self.end_headers()
            return

        content_length = int(self.headers.get("Content-Length", 0))
        post_data = self.rfile.read(content_length)

        try:
            data = json.loads(post_data.decode("utf-8"))
            problem = data.get("problem", {})
            language = data.get("language", "python")
            existing_code = data.get("existing_code", "")

            # Smart detection: ML / Data Science courses & Pandas problems require Python
            stmt = (problem.get("statement", "") + " " + problem.get("url", "") + " " + existing_code).lower()
            if any(k in stmt for k in ["pandas", "sklearn", "numpy", "dataframe", "read_csv", "matplotlib", "seaborn", "-ml-", "scikit", "label_encoder", "onehot"]):
                language = "python"

            print(f"[Bridge] Received solve request for: {problem.get('title')} ({problem.get('code')}) in {language} (existing code: {len(existing_code)} chars)")

            prompt = build_prompt(problem, language, existing_code)

            # Call agy CLI safely with lock
            with SOLVE_LOCK:
                proc = subprocess.run(
                    [AGY_PATH, "--effort", "low", "-p", prompt],
                    stdin=subprocess.DEVNULL,
                    capture_output=True,
                    text=True,
                    timeout=90
                )

            if proc.returncode != 0:
                err_msg = proc.stderr.strip() or "agy exited with non-zero status"
                print(f"[Bridge] Error from agy: {err_msg}")
                self.send_response(500)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "error": err_msg}).encode("utf-8"))
                return

            raw_code = proc.stdout.strip()
            final_code = clean_code(raw_code)

            print(f"[Bridge] Successfully generated solution ({len(final_code)} bytes)")

            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "ok": True,
                "code": final_code,
                "language": language
            }).encode("utf-8"))

        except Exception as e:
            print(f"[Bridge] Exception in handler: {e}")
            self.send_response(500)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": False, "error": str(e)}).encode("utf-8"))

    def log_message(self, format, *args):
        # Clean logging
        sys.stderr.write(f"[Bridge HTTP] {self.address_string()} - {format % args}\n")

def main():
    server = ThreadedHTTPServer((HOST, PORT), BridgeHandler)
    print(f"🚀 Antigravity Bridge running on http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down bridge server.")
        server.server_close()

if __name__ == "__main__":
    main()
