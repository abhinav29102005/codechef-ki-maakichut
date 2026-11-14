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

def sanitize_existing_code(code):
    if not code:
        return ""
    lines = code.splitlines()
    first_import = -1
    duplicate_cutoff = -1
    for idx, line in enumerate(lines):
        l = line.strip().lower()
        if l.startswith("import pandas") or l.startswith("from sklearn"):
            if first_import == -1:
                first_import = idx
            elif idx > first_import + 5:
                duplicate_cutoff = idx
                break
        elif re.search(r"^\s*#\s*step\s*1\b", line, re.IGNORECASE) and idx > 10:
            duplicate_cutoff = idx
            break

    if duplicate_cutoff > 0:
        cleaned = "\n".join(lines[:duplicate_cutoff]).strip()
        print(f"[Bridge] Truncated corrupted/duplicate existing code from {len(lines)} lines to {duplicate_cutoff} lines.")
        return cleaned
    return code.strip()

def build_prompt(problem, language, existing_code=""):
    lang_name = format_language(language)
    samples_str = ""
    samples = problem.get("samples") or []
    for i, s in enumerate(samples):
        samples_str += f"\nSample {i+1} Input:\n{s.get('input', '')}\nSample {i+1} Output:\n{s.get('output', '')}\n"

    sanitized_code = sanitize_existing_code(existing_code)
    existing_section = ""
    if sanitized_code:
        existing_section = f"""
======================================================================
STARTER TEMPLATE IN THE STUDENT'S EDITOR:
======================================================================
```{language}
{sanitized_code}
```
======================================================================
CRITICAL STARTER TEMPLATE RULES:
1. The student's editor contains the starter code shown above with blanks (like '_________', '...', or incomplete expressions).
2. You MUST replace every single blank '_________' in-place with the exact, correct code.
3. DO NOT leave any '_________' in your output! If '_________' remains, Python will raise a NameError or SyntaxError.
4. DO NOT append duplicate code, duplicate imports, or duplicate steps at the bottom! Return ONE single, clean, cohesive file.
5. PRESERVE existing comments and print() statements from the template so the output matches CodeChef's expected formatting.
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
2. If starter template was provided above:
   - Fill in ALL blanks ('_________') in-place.
   - UNDER NO CIRCUMSTANCES should '_________' exist in your output.
   - Output must be valid, complete {lang_name} code that runs from start to finish without syntax or runtime errors.
   - Do NOT duplicate imports or write multiple copies of the steps.
3. If no starter template was provided, write the complete solution from scratch.
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
        if self.path == "/log":
            content_length = int(self.headers.get("Content-Length", 0))
            post_data = self.rfile.read(content_length)
            try:
                msg = json.loads(post_data.decode("utf-8"))
                print(f"[Browser Log] {json.dumps(msg, indent=2)}")
            except Exception:
                print(f"[Browser Log Raw] {post_data.decode('utf-8', errors='ignore')}")
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
            return

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
            if existing_code:
                print(f"[Bridge] --- START EXISTING CODE ---\n{existing_code}\n--- END EXISTING CODE ---")

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

            # Post-generation validation for Python: syntax check and blanks check
            if language == "python":
                syntax_err = None
                try:
                    compile(final_code, "<string>", "exec")
                except SyntaxError as se:
                    syntax_err = f"SyntaxError: {se}"

                has_unfilled_blanks = "____" in final_code

                if syntax_err or has_unfilled_blanks:
                    reason = syntax_err if syntax_err else "Code still contains unfilled blanks (____)"
                    print(f"[Bridge] Warning: Initial code has issue ({reason}). Running quick correction pass…")
                    correct_prompt = f"""The following Python code has a fatal issue: {reason}.
Original code:
```python
{final_code}
```
Fix the syntax error and fill in all blanks with valid python code.
Output ONLY the clean, valid Python code inside a single ```python ... ``` block. No explanations."""
                    with SOLVE_LOCK:
                        proc2 = subprocess.run(
                            [AGY_PATH, "--effort", "low", "-p", correct_prompt],
                            stdin=subprocess.DEVNULL,
                            capture_output=True,
                            text=True,
                            timeout=60
                        )
                    if proc2.returncode == 0:
                        corrected = clean_code(proc2.stdout.strip())
                        try:
                            compile(corrected, "<string>", "exec")
                            final_code = corrected
                            print("[Bridge] Successfully corrected syntax/blanks!")
                        except Exception as e2:
                            print(f"[Bridge] Correction pass also had syntax issue: {e2}")

            print(f"[Bridge] Successfully generated solution ({len(final_code)} bytes)")
            print(f"[Bridge] --- START GENERATED CODE ---\n{final_code}\n--- END GENERATED CODE ---")

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
