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
    return lang_code or "C++"

def build_prompt(problem, language):
    lang_name = format_language(language)
    samples_str = ""
    samples = problem.get("samples") or []
    for i, s in enumerate(samples):
        samples_str += f"\nSample {i+1} Input:\n{s.get('input', '')}\nSample {i+1} Output:\n{s.get('output', '')}\n"

    prompt = f"""You are an elite competitive programmer solving a CodeChef problem.
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

CRITICAL REQUIREMENTS:
1. Provide a 100% correct, bug-free, and optimal solution that passes all test cases within the time and memory limits.
2. If the problem asks for standard I/O, read strictly from standard input (stdin) and write strictly to standard output (stdout). If it asks to complete a specific function or write an ML script (NumPy, Scikit-learn, etc.), provide the exact code required.
3. If C++: Use `#include <bits/stdc++.h>`, fast I/O (`ios_base::sync_with_stdio(false); cin.tie(NULL);`), and appropriate types like `long long` to prevent integer overflow.
4. If Python: Write idiomatic, clean Python 3. Use `sys.stdin.read` or `sys.stdin.readline` where large inputs are expected.
5. Output ONLY the raw source code inside a single ```{language} ... ``` code block. Absolutely no explanation, analysis, or conversational text.
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
            language = data.get("language", "cpp")

            # Smart detection: ML / Data Science courses & Pandas problems require Python
            stmt = (problem.get("statement", "") + " " + problem.get("url", "")).lower()
            if any(k in stmt for k in ["pandas", "sklearn", "numpy", "dataframe", "read_csv", "matplotlib", "seaborn", "-ml-", "scikit"]):
                language = "python"

            print(f"[Bridge] Received solve request for: {problem.get('title')} ({problem.get('code')}) in {language}")

            prompt = build_prompt(problem, language)

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
            print(f"[Bridge] Exception during solve: {e}")
            self.send_response(500)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": False, "error": str(e)}).encode("utf-8"))

    def log_message(self, format, *args):
        # Clean logging
        sys.stderr.write(f"[Bridge] {self.address_string()} - {format % args}\n")

def run():
    server = ThreadedHTTPServer((HOST, PORT), BridgeHandler)
    print(f"🚀 Antigravity Bridge running on http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down bridge server.")
        server.server_close()

if __name__ == "__main__":
    run()

