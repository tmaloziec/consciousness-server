#!/usr/bin/env python3
"""MCP Test Runner Service - Run tests for projects"""
from flask import Flask, request, jsonify
from flask_cors import CORS
import subprocess
import threading
import uuid
import os
from datetime import datetime

from middleware.verify_signed import flask_middleware

app = Flask(__name__)
CORS(app)
flask_middleware(app)  # Gated by AUTH_MODE (off | observe | enforce)

test_history = {}
running_tests = {}

@app.route("/health")
def health():
    return jsonify({"status": "ok", "service": "test-runner", "port": 3041})

@app.route("/api/test/run", methods=["POST"])
def run_test():
    data = request.json or {}
    project_path = data.get("project_path")
    test_type = data.get("test_type", "pytest")
    
    if not project_path or not os.path.exists(project_path):
        return jsonify({"error": f"Project path does not exist: {project_path}"}), 400
    
    test_id = str(uuid.uuid4())
    
    cmd_map = {
        "pytest": ["pytest", "-v"],
        "npm": ["npm", "test"],
        "vitest": ["npx", "vitest", "run"],
    }
    if test_type not in cmd_map:
        return jsonify({
            "error": "Unsupported test_type",
            "allowed": sorted(cmd_map.keys()),
        }), 400
    cmd = cmd_map[test_type]

    def run():
        start = datetime.now()
        try:
            result = subprocess.run(cmd, shell=False, cwd=project_path,
                                    capture_output=True, text=True, timeout=300)
            test_history[test_id] = {
                "test_id": test_id,
                "status": "passed" if result.returncode == 0 else "failed",
                "output": result.stdout + result.stderr,
                "return_code": result.returncode,
                "duration": (datetime.now() - start).total_seconds()
            }
        except Exception as e:
            test_history[test_id] = {"test_id": test_id, "status": "error", "error": str(e)}
    
    threading.Thread(target=run, daemon=True).start()
    return jsonify({"test_id": test_id, "status": "running"})

@app.route("/api/test/<test_id>")
def get_test(test_id):
    if test_id in test_history:
        return jsonify(test_history[test_id])
    return jsonify({"status": "running"})

@app.route("/api/test/history")
def get_history():
    return jsonify({"tests": list(test_history.values())[-20:]})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=3041)
