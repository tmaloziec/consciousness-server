#!/usr/bin/env python3
"""MCP Git Workflow Service - Track git commits by agents"""
from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import sqlite3
import os
from datetime import datetime

from middleware.verify_signed import stdlib_gate  # Auth gate

DB_PATH = os.getenv("DB_PATH", "./commits.db")
PORT = int(os.getenv("PORT", 3042))

def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""CREATE TABLE IF NOT EXISTS commits (
        id INTEGER PRIMARY KEY, repo TEXT, hash TEXT, agent TEXT, 
        message TEXT, files TEXT, timestamp TEXT)""")
    conn.commit()
    conn.close()

class Handler(BaseHTTPRequestHandler):
    @stdlib_gate
    def do_GET(self):
        if self.path == "/health":
            self.send_json({"status": "ok", "service": "git-workflow", "port": PORT})
        elif self.path.startswith("/api/git/history"):
            conn = sqlite3.connect(DB_PATH)
            rows = conn.execute("SELECT * FROM commits ORDER BY id DESC LIMIT 50").fetchall()
            conn.close()
            commits = [{"id": r[0], "repo": r[1], "hash": r[2], "agent": r[3],
                       "message": r[4], "files": json.loads(r[5] or "[]"), "timestamp": r[6]} for r in rows]
            self.send_json({"commits": commits})
        else:
            self.send_json({"error": "Not found"}, 404)

    @stdlib_gate
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        data = json.loads(self.rfile.read(length)) if length else {}

        if self.path == "/api/git/hook/post-commit":
            conn = sqlite3.connect(DB_PATH)
            conn.execute("INSERT INTO commits (repo,hash,agent,message,files,timestamp) VALUES (?,?,?,?,?,?)",
                        (data.get("repo"), data.get("hash"), data.get("agent", "unknown"),
                         data.get("message"), json.dumps(data.get("files", [])), datetime.now().isoformat()))
            conn.commit()
            conn.close()
            self.send_json({"status": "recorded"})
        else:
            self.send_json({"error": "Not found"}, 404)
    
    def send_json(self, data, code=200):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())
    
    def log_message(self, format, *args): pass

if __name__ == "__main__":
    init_db()
    print(f"Git Workflow running on port {PORT}")
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
