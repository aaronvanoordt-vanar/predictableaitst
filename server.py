#!/usr/bin/env python3
# Servidor proxy local para Apollo API
# Uso: python3 server.py
# Luego abre http://localhost:3000 en tu navegador

import http.server, urllib.request, urllib.parse, json, os, sys

PORT = 3000
APOLLO_KEY = 'GJhODHZj1VvjE9H1TdD_KA'
APOLLO_BASE = 'https://api.apollo.io/api/v1'
DIR = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"  {args[0]} {args[1]}")

    def send_cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type,X-Api-Key')

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors()
        self.end_headers()

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_cors()
        self.end_headers()
        with open(os.path.join(DIR, 'index.html'), 'rb') as f:
            self.wfile.write(f.read())

    def do_POST(self):
        if not self.path.startswith('/proxy/apollo/'):
            self.send_response(404); self.end_headers(); return

        apollo_path = self.path.replace('/proxy/apollo/', '/')
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)

        req = urllib.request.Request(
            APOLLO_BASE + apollo_path,
            data=body,
            headers={
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache',
                'X-Api-Key': APOLLO_KEY,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Origin': 'https://app.apollo.io',
                'Referer': 'https://app.apollo.io/',
            },
            method='POST'
        )
        try:
            with urllib.request.urlopen(req) as resp:
                data = resp.read()
                self.send_response(resp.status)
                self.send_header('Content-Type', 'application/json')
                self.send_cors()
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            data = e.read()
            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json')
            self.send_cors()
            self.end_headers()
            self.wfile.write(data)

print(f"\n✅ Servidor corriendo en http://localhost:{PORT}")
print(f"   Abre esa URL en tu navegador\n")
httpd = http.server.HTTPServer(('', PORT), Handler)
httpd.serve_forever()
