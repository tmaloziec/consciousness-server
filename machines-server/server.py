#!/usr/bin/env python3
"""
===============================================================================
Machines Server - Infrastructure Awareness for AI Agents
===============================================================================
Port: 3038

Provides real-time system information and infrastructure overview for AI agents.
Enables agents to understand the ecosystem they operate in.

ENDPOINTS:
  GET /health              - Health check
  GET /api/system          - Real-time CPU/RAM/Disk/GPU stats
  GET /api/infrastructure  - Full ecosystem overview (machines, services, agents)
  GET /api/machines        - Static machine definitions from config files
  GET /mcp/tools           - MCP tool definitions
  POST /mcp/call           - Execute MCP tool

CONFIG:
  Machines are defined in MACHINES_DIR (default ./machines/*.yaml).
  Each file describes one machine in the ecosystem.
===============================================================================
"""

import os
import json
import glob
import subprocess
import psutil
import yaml
from flask import Flask, jsonify, request
from datetime import datetime

from middleware.verify_signed import flask_middleware

app = Flask(__name__)
flask_middleware(app)  # gated by AUTH_MODE (off | observe | enforce)

# =============================================================================
# CONFIGURATION
# =============================================================================
CS_URL = os.getenv('CS_URL', 'http://localhost:3032')
PORT = int(os.getenv('PORT', 3038))
MACHINES_CONFIG_DIR = os.getenv('MACHINES_DIR', './machines')

# =============================================================================
# HELPER FUNCTIONS - GPU INFO
# =============================================================================
def get_gpu_info():
    """
    Get NVIDIA GPU information using nvidia-smi.
    Returns None if no NVIDIA GPU is available.

    Returns:
        dict: {name, utilization_percent, memory_used_mb, memory_total_mb, temperature_c}
    """
    try:
        result = subprocess.run([
            'nvidia-smi',
            '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu',
            '--format=csv,noheader,nounits'
        ], capture_output=True, text=True, timeout=5)

        if result.returncode == 0:
            parts = result.stdout.strip().split(', ')
            return {
                'name': parts[0],
                'utilization_percent': int(parts[1]),
                'memory_used_mb': int(parts[2]),
                'memory_total_mb': int(parts[3]),
                'temperature_c': int(parts[4]) if len(parts) > 4 else None
            }
    except Exception as e:
        pass
    return None

# =============================================================================
# HELPER FUNCTIONS - SYSTEM INFO
# =============================================================================
def get_system_info():
    """
    Get current system resource usage (CPU, RAM, Disk, GPU).
    Uses psutil for cross-platform compatibility.

    Returns:
        dict: {cpu: {...}, memory: {...}, disk: {...}, gpu: {...}}
    """
    cpu_percent = psutil.cpu_percent(interval=0.5)
    memory = psutil.virtual_memory()
    disk = psutil.disk_usage('/')

    return {
        'hostname': os.uname().nodename,
        'timestamp': datetime.utcnow().isoformat() + 'Z',
        'cpu': {
            'percent': cpu_percent,
            'cores': psutil.cpu_count(),
            'load_avg': list(os.getloadavg()) if hasattr(os, 'getloadavg') else None
        },
        'memory': {
            'total_gb': round(memory.total / (1024**3), 1),
            'used_gb': round(memory.used / (1024**3), 1),
            'available_gb': round(memory.available / (1024**3), 1),
            'percent': memory.percent
        },
        'disk': {
            'total_gb': round(disk.total / (1024**3), 1),
            'used_gb': round(disk.used / (1024**3), 1),
            'free_gb': round(disk.free / (1024**3), 1),
            'percent': round(disk.percent, 1)
        },
        'gpu': get_gpu_info()
    }

# =============================================================================
# HELPER FUNCTIONS - MACHINE CONFIGS
# =============================================================================
def load_machine_configs():
    """
    Load machine definitions from YAML files in MACHINES_CONFIG_DIR.
    Each .yaml file represents one machine in the ecosystem.

    Returns:
        list: List of machine config dictionaries
    """
    machines = []
    config_pattern = os.path.join(MACHINES_CONFIG_DIR, '*.yaml')

    for filepath in glob.glob(config_pattern):
        try:
            with open(filepath, 'r') as f:
                config = yaml.safe_load(f)
                if config:
                    config['_config_file'] = os.path.basename(filepath)
                    machines.append(config)
        except Exception as e:
            print(f"Error loading {filepath}: {e}")

    return machines

# =============================================================================
# ROUTES - HEALTH CHECK
# =============================================================================
@app.route('/health', methods=['GET'])
def health():
    """Simple health check endpoint."""
    return jsonify({
        'status': 'ok',
        'service': 'machines-server',
        'version': '2.0.0'
    })

# =============================================================================
# ROUTES - REAL-TIME SYSTEM INFO
# =============================================================================
@app.route('/api/system', methods=['GET'])
def system_info():
    """
    Get real-time system resources for THIS machine.
    Useful for monitoring current load.
    """
    return jsonify(get_system_info())

# =============================================================================
# ROUTES - STATIC MACHINE CONFIGS
# =============================================================================
@app.route('/api/machines', methods=['GET'])
def machines_config():
    """
    Get static machine definitions from config files.
    Returns all machines defined in MACHINES_DIR/*.yaml
    """
    machines = load_machine_configs()
    return jsonify({
        'machines': machines,
        'total': len(machines),
        'config_dir': MACHINES_CONFIG_DIR
    })

# =============================================================================
# ROUTES - FULL INFRASTRUCTURE OVERVIEW
# =============================================================================
@app.route('/api/infrastructure', methods=['GET'])
def infrastructure():
    """
    Get full infrastructure overview for AI agents.
    Combines: local system stats + machine configs + CS data (services, agents)
    """
    import requests

    # Get machines from config files
    machine_configs = load_machine_configs()

    # Get machines from CS (runtime data)
    try:
        cs_machines = requests.get(f'{CS_URL}/api/machines', timeout=5).json()
    except:
        cs_machines = {'machines': []}

    # Get services status from CS
    try:
        services = {'services': get_services_with_status()}
    except:
        services = {'services': []}

    # Get agents from CS
    try:
        agents = requests.get(f'{CS_URL}/api/agents', timeout=5).json()
    except:
        agents = {'agents': []}

    return jsonify({
        'local_system': get_system_info(),
        'machine_configs': machine_configs,
        'runtime_machines': cs_machines.get('machines', []),
        'services': services.get('services', []),
        'agents': agents.get('agents', []),
        'summary': {
            'total_configured_machines': len(machine_configs),
            'total_runtime_machines': len(cs_machines.get('machines', [])),
            'online_agents': len([a for a in agents.get('agents', []) if a.get('status') == 'ONLINE']),
            'gpu_available': get_gpu_info() is not None
        }
    })

# =============================================================================
# ROUTES - MCP PROTOCOL SUPPORT
# =============================================================================
@app.route('/mcp/tools', methods=['GET'])
def mcp_tools():
    """
    MCP tool definitions for Claude Code.
    These tools can be invoked via /mcp/call endpoint.
    """
    return jsonify({
        'tools': [
            {
                'name': 'get_system_resources',
                'description': 'Get current CPU, RAM, Disk, GPU usage on this machine',
                'inputSchema': {'type': 'object', 'properties': {}}
            },
            {
                'name': 'get_infrastructure',
                'description': 'Get full infrastructure overview - machines, services, agents',
                'inputSchema': {'type': 'object', 'properties': {}}
            },
            {
                'name': 'list_machines',
                'description': 'List all machines defined in the ecosystem',
                'inputSchema': {'type': 'object', 'properties': {}}
            }
        ]
    })

@app.route('/mcp/call', methods=['POST'])
def mcp_call():
    """
    Execute MCP tool by name.
    Body: {"tool": "tool_name", "args": {...}}
    """
    data = request.json
    tool = data.get('tool')

    if tool == 'get_system_resources':
        return jsonify({'result': get_system_info()})
    elif tool == 'get_infrastructure':
        return infrastructure()
    elif tool == 'list_machines':
        return machines_config()
    else:
        return jsonify({'error': f'Unknown tool: {tool}'}), 400

# =============================================================================
# MAIN
# =============================================================================
# DYNAMIC SERVICE CHECKING FROM services.yaml
# =============================================================================
import socket
import http.client

SERVICES_YAML = os.getenv('SERVICES_YAML', './services.yaml')

def load_services_config():
    """Load services to check from YAML config."""
    try:
        with open(SERVICES_YAML, 'r') as f:
            config = yaml.safe_load(f)
            return config.get('services', [])
    except Exception as e:
        return []

def check_service_status(service):
    """Check if a service is responding on its port."""
    try:
        conn = http.client.HTTPConnection('localhost', service['port'], timeout=2)
        conn.request('GET', service.get('path', '/health'))
        response = conn.getresponse()
        conn.close()
        # Accept 200-499 as "active" (including WebSocket upgrades, redirects, etc.)
        if response.status < 500:
            return 'active'
        return 'inactive'
    except:
        return 'inactive'

def get_services_with_status():
    """Load services from config and check their status dynamically."""
    services = load_services_config()
    result = {}
    for svc in services:
        status = check_service_status(svc)
        result[svc['name']] = {
            'port': svc['port'],
            'path': svc.get('path', '/health'),
            'description': svc.get('description', ''),
            'status': status
        }
    return result

@app.route('/', methods=['GET'])
def index():
    """Root endpoint."""
    return jsonify({
        'service': 'machines-server',
        'version': '1.0.0',
        'endpoints': ['/', '/health', '/api/system', '/api/machines', '/api/infrastructure', '/api/services']
    })

@app.route('/api/services', methods=['GET'])
def services_endpoint():
    """Get all services with dynamically checked status."""
    return jsonify({
        'services': get_services_with_status(),
        'checked_at': datetime.now().isoformat()
    })

if __name__ == '__main__':
    print("=" * 60)
    print("Machines Server v2.0")
    print("=" * 60)
    print(f"  Port:        {PORT}")
    print(f"  CS URL:      {CS_URL}")
    print(f"  Machines:    {MACHINES_CONFIG_DIR}")
    print("=" * 60)
    app.run(host='0.0.0.0', port=PORT)
