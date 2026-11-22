"""Send one command to the Blender MCP addon on 127.0.0.1:9876.

  python tools/blender/send.py tools/blender/fit_rifle.py
  python tools/blender/send.py tools/blender/screenshot.json
"""
import json
import socket
import sys
import time

path = sys.argv[1]
if path.endswith(".json"):
    with open(path, encoding="utf-8") as fh:
        command = json.load(fh)
else:
    with open(path, encoding="utf-8") as fh:
        command = {"type": "execute_code", "params": {"code": fh.read()}}

sock = socket.create_connection(("127.0.0.1", 9876), timeout=900)
sock.settimeout(900)
sock.sendall(json.dumps(command).encode("utf-8"))

buf = b""
data = None
deadline = time.time() + 900
while time.time() < deadline:
    chunk = sock.recv(65536)
    if not chunk:
        break
    buf += chunk
    try:
        data = json.loads(buf.decode("utf-8"))
        break
    except (json.JSONDecodeError, UnicodeDecodeError):
        continue

sock.close()
if data is None:
    data = {"status": "error", "message": "no JSON reply", "raw": buf.decode("utf-8", "replace")[:2000]}
print(json.dumps(data, indent=1)[:20000])
