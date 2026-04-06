# Recommended to run in your OpenClaw's workspace - Modify path if not workspace
# This is needed if you want to stream local content to your webchat session
# Images are sent via Data base64 embeding. All other media is streamed.
#
#!/usr/bin/env python3
"""
Simple Media Server for WebChat
Serves images, audio, and video files from the current directory with proper CORS headers
Supports range requests for seeking in audio/video
"""

import os
import sys
import json
import mimetypes
import argparse
import math
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, unquote, parse_qs
import base64
from pathlib import Path

class MediaServerHandler(SimpleHTTPRequestHandler):
    """Custom handler that serves media files with proper headers"""
    
    def __init__(self, *args, **kwargs):
        self.directory = os.getcwd()
        super().__init__(*args, **kwargs)
    
    def do_GET(self):
        """Handle GET requests"""
        parsed_path = urlparse(self.path)
        path = unquote(parsed_path.path)
        query_params = parse_qs(parsed_path.query)
        
        # Handle API endpoints
        if path == '/api/list':
            page = int(query_params.get('page', [1])[0])
            per_page = int(query_params.get('per_page', [20])[0])
            self.handle_list_media(page, per_page)
        elif path == '/api/media-info':
            self.handle_media_info(parsed_path.query)
        elif path == '/' or path == '':
            # Serve status page with file listing
            page = int(query_params.get('page', [1])[0])
            self.serve_status_page(page)
        else:
            # Serve files normally with range support
            self.serve_file_with_range(path)
    
    def get_media_file_list(self, max_depth=2):
        """Return list of media files in the directory (limited to max_depth subdirectories)"""
        media_files = []
        media_extensions = {
            'image': ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'],
            'audio': ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.opus', '.wma'],
            'video': ['.mp4', '.webm', '.avi', '.mov', '.mkv', '.m4v', '.mpg', '.mpeg']
        }
        
        # Walk directories with depth limit
        for root, dirs, files in os.walk('.'):
            # Calculate current depth
            rel_path = os.path.relpath(root, '.')
            if rel_path == '.':
                depth = 0
            else:
                depth = len(rel_path.split(os.sep))
            
            # Skip if depth exceeds max_depth
            if depth > max_depth:
                # Remove subdirectories to prevent further walking
                dirs.clear()
                continue
            
            for file in files:
                ext = os.path.splitext(file)[1].lower()
                media_type = None
                for mtype, exts in media_extensions.items():
                    if ext in exts:
                        media_type = mtype
                        break
                
                if media_type:
                    full_path = os.path.join(root, file)
                    rel_path_file = os.path.relpath(full_path, '.')
                    mime_type, _ = mimetypes.guess_type(file)
                    if not mime_type:
                        mime_map = {
                            '.ogg': 'audio/ogg',
                            '.mp3': 'audio/mpeg',
                            '.wav': 'audio/wav',
                            '.flac': 'audio/flac',
                            '.m4a': 'audio/mp4',
                            '.aac': 'audio/aac',
                            '.opus': 'audio/opus',
                            '.mp4': 'video/mp4',
                            '.webm': 'video/webm',
                            '.avi': 'video/x-msvideo',
                            '.mov': 'video/quicktime',
                            '.mkv': 'video/x-matroska',
                            '.wma': 'audio/x-ms-wma'
                        }
                        mime_type = mime_map.get(ext, f'{media_type}/x-unknown')
                    
                    media_files.append({
                        'path': rel_path_file,
                        'filename': file,
                        'mimeType': mime_type,
                        'type': media_type,
                        'size': os.path.getsize(full_path),
                        'depth': depth
                    })
        
        # Sort by filename
        media_files.sort(key=lambda x: x['filename'])
        return media_files
    
    def format_size(self, size):
        """Format file size in human-readable format"""
        for unit in ['B', 'KB', 'MB', 'GB']:
            if size < 1024.0:
                return f"{size:.1f} {unit}"
            size /= 1024.0
        return f"{size:.1f} TB"
    
    def serve_status_page(self, page=1):
        """Serve a status page with paginated file listing"""
        per_page = 20
        all_media = self.get_media_file_list(max_depth=2)
        total_files = len(all_media)
        total_pages = math.ceil(total_files / per_page) if total_files > 0 else 1
        
        # Ensure page is within bounds
        page = max(1, min(page, total_pages))
        
        # Get paginated files
        start_idx = (page - 1) * per_page
        end_idx = start_idx + per_page
        media_files = all_media[start_idx:end_idx]
        
        # Generate file listing HTML
        file_list_html = ''
        for media in media_files:
            file_list_html += f'''
            <tr>
                <td><a href="/{media['path']}" target="_blank">{media['filename']}</a></td>
                <td><span class="badge badge-{media['type']}">{media['type']}</span></td>
                <td>{media['mimeType']}</td>
                <td>{self.format_size(media['size'])}</td>
            </tr>
            '''
        
        if not file_list_html:
            file_list_html = '<tr><td colspan="4">No media files found in current directory (max depth: 2 folders)</td></tr>'
        
        # Generate pagination HTML
        pagination_html = ''
        if total_pages > 1:
            pagination_html = '<div class="pagination">'
            
            # Previous button
            if page > 1:
                pagination_html += f'<a href="/?page={page-1}">&laquo; Previous</a>'
            
            # Page numbers
            start_page = max(1, page - 2)
            end_page = min(total_pages, page + 2)
            for p in range(start_page, end_page + 1):
                if p == page:
                    pagination_html += f'<span class="active">{p}</span>'
                else:
                    pagination_html += f'<a href="/?page={p}">{p}</a>'
            
            # Next button
            if page < total_pages:
                pagination_html += f'<a href="/?page={page+1}">Next &raquo;</a>'
            
            pagination_html += '</div>'
        
        html = f'''<!DOCTYPE html>
<html>
<head>
    <title>OpenClaw Media Server</title>
    <meta charset="utf-8">
    <style>
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f5f5;
        }}
        h1 {{
            color: #333;
            border-bottom: 2px solid #4CAF50;
            padding-bottom: 10px;
        }}
        .status {{
            background: #4CAF50;
            color: white;
            padding: 10px;
            border-radius: 5px;
            margin: 10px 0;
        }}
        .stats {{
            background: #2196F3;
            color: white;
            padding: 8px;
            border-radius: 5px;
            margin: 10px 0;
            font-size: 14px;
        }}
        table {{
            width: 100%;
            border-collapse: collapse;
            background: white;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }}
        th, td {{
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid #ddd;
        }}
        th {{
            background: #4CAF50;
            color: white;
        }}
        tr:hover {{
            background: #f5f5f5;
        }}
        .footer {{
            margin-top: 20px;
            text-align: center;
            color: #666;
            font-size: 12px;
        }}
        .badge {{
            display: inline-block;
            padding: 2px 8px;
            border-radius: 3px;
            font-size: 11px;
            font-weight: bold;
        }}
        .badge-audio {{ background: #2196F3; color: white; }}
        .badge-video {{ background: #9C27B0; color: white; }}
        .badge-image {{ background: #FF9800; color: white; }}
        .pagination {{
            margin: 20px 0;
            text-align: center;
        }}
        .pagination a, .pagination span {{
            display: inline-block;
            padding: 8px 12px;
            margin: 0 4px;
            text-decoration: none;
            border: 1px solid #ddd;
            background: white;
            border-radius: 4px;
        }}
        .pagination a:hover {{
            background: #4CAF50;
            color: white;
        }}
        .pagination .active {{
            background: #4CAF50;
            color: white;
            border: 1px solid #4CAF50;
        }}
        .depth-info {{
            font-size: 12px;
            color: #666;
            margin-top: 5px;
        }}
    </style>
</head>
<body>
    <h1>🎵 OpenClaw Media Server</h1>
    <div class="status">
        ✅ Media server is running | Port: {getattr(global_args, 'port', 18791)} | Directory: {os.getcwd()}
    </div>
    <div class="stats">
        📊 Total media files: {total_files} (limited to 2 directory levels deep) | Page {page} of {total_pages} | Showing {len(media_files)} files
    </div>
    
    <h2>📁 Media Files</h2>
    <table>
        <thead>
            <tr>
                <th>Filename</th>
                <th>Type</th>
                <th>MIME Type</th>
                <th>Size</th>
            </tr>
        </thead>
        <tbody>
            {file_list_html}
        </tbody>
    </table>
    
    {pagination_html}
    
    <div class="depth-info">
        ⓘ Only scanning 2 directory levels deep. Files in deeper folders are not shown.
    </div>
    
    <div class="footer">
        <p>OpenClaw Media Server - Supports seeking, streaming, and CORS</p>
        <p>📷 Images | 🎵 Audio (mp3, wav, ogg, flac, m4a, aac, opus, wma) | 🎬 Video (mp4, webm, avi, mov, mkv, m4v, mpg, mpeg)</p>
    </div>
</body>
</html>'''
        
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(html.encode())
    
    def handle_list_media(self, page=1, per_page=20):
        """Return JSON list of media files with pagination"""
        all_media = self.get_media_file_list(max_depth=2)
        total_files = len(all_media)
        total_pages = math.ceil(total_files / per_page) if total_files > 0 else 1
        
        # Ensure page is within bounds
        page = max(1, min(page, total_pages))
        
        # Get paginated files
        start_idx = (page - 1) * per_page
        end_idx = start_idx + per_page
        media_files = all_media[start_idx:end_idx]
        
        response = {
            'page': page,
            'per_page': per_page,
            'total': total_files,
            'total_pages': total_pages,
            'files': media_files
        }
        
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(response, indent=2).encode())
    
    def handle_media_info(self, query):
        """Get info about a specific media file"""
        params = {}
        if query:
            for param in query.split('&'):
                if '=' in param:
                    key, value = param.split('=', 1)
                    params[key] = value
        
        media_path = params.get('path', '')
        if not media_path:
            self.send_error(400, 'Missing path parameter')
            return
        
        # Security: prevent directory traversal
        safe_path = os.path.normpath(os.path.join('.', media_path))
        if not safe_path.startswith('.'):
            self.send_error(403, 'Access denied')
            return
        
        if os.path.isdir(safe_path):
            self.send_error(400, 'Path is a directory')
            return
        
        if not os.path.exists(safe_path):
            self.send_error(404, 'File not found')
            return
        
        mime_type, _ = mimetypes.guess_type(safe_path)
        ext = os.path.splitext(safe_path)[1].lower()
        
        # Handle common audio/video MIME types
        if not mime_type:
            mime_map = {
                '.ogg': 'audio/ogg',
                '.mp3': 'audio/mpeg',
                '.wav': 'audio/wav',
                '.flac': 'audio/flac',
                '.m4a': 'audio/mp4',
                '.aac': 'audio/aac',
                '.opus': 'audio/opus',
                '.mp4': 'video/mp4',
                '.webm': 'video/webm',
                '.avi': 'video/x-msvideo',
                '.mov': 'video/quicktime',
                '.mkv': 'video/x-matroska'
            }
            mime_type = mime_map.get(ext, 'application/octet-stream')
        
        try:
            with open(safe_path, 'rb') as f:
                media_data = f.read()
            
            base64_data = base64.b64encode(media_data).decode('ascii')
            
            response = {
                'path': media_path,
                'mimeType': mime_type,
                'size': len(media_data),
                'base64': base64_data,
                'dataUrl': f'data:{mime_type};base64,{base64_data}'
            }
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())
            
        except Exception as e:
            self.send_error(500, f'Error reading file: {str(e)}')
    
    def serve_file_with_range(self, path):
        """Serve file with support for range requests (for seeking in audio/video)"""
        # Security: prevent directory traversal
        # Normalize the path and ensure it's within the current directory
        safe_path = os.path.normpath(os.path.join('.', path.lstrip('/')))
        
        # Check if it's a directory
        if os.path.isdir(safe_path):
            self.send_error(404, 'Not found')
            return
        
        # Security: ensure the resolved path is within the current directory
        # (don't allow ../ to escape)
        resolved = os.path.abspath(safe_path)
        current = os.path.abspath('.')
        if not resolved.startswith(current):
            self.send_error(403, 'Access denied')
            return
        
        if not os.path.exists(safe_path):
            self.send_error(404, 'File not found')
            return
        
        # Get file size
        file_size = os.path.getsize(safe_path)
        
        # Parse Range header
        range_header = self.headers.get('Range')
        start = 0
        end = file_size - 1
        status_code = 200
        
        if range_header and range_header.startswith('bytes='):
            status_code = 206
            range_value = range_header[6:]
            if '-' in range_value:
                parts = range_value.split('-')
                if parts[0]:
                    start = int(parts[0])
                if parts[1]:
                    end = int(parts[1])
        
        # Validate range
        if start >= file_size or end >= file_size or start > end:
            self.send_error(416, 'Requested range not satisfiable')
            return
        
        content_length = end - start + 1
        
        # Get MIME type
        mime_type, _ = mimetypes.guess_type(safe_path)
        ext = os.path.splitext(safe_path)[1].lower()
        if not mime_type:
            mime_map = {
                '.ogg': 'audio/ogg',
                '.mp3': 'audio/mpeg',
                '.wav': 'audio/wav',
                '.flac': 'audio/flac',
                '.m4a': 'audio/mp4',
                '.aac': 'audio/aac',
                '.opus': 'audio/opus',
                '.mp4': 'video/mp4',
                '.webm': 'video/webm',
                '.avi': 'video/x-msvideo',
                '.mov': 'video/quicktime',
                '.mkv': 'video/x-matroska',
                '.m4v': 'video/x-m4v',
                '.mpg': 'video/mpeg',
                '.mpeg': 'video/mpeg',
            }
            mime_type = mime_map.get(ext, 'application/octet-stream')
        
        self.send_response(status_code)
        self.send_header('Content-Type', mime_type)
        self.send_header('Content-Length', str(content_length))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        
        # Send the requested range
        with open(safe_path, 'rb') as f:
            f.seek(start)
            remaining = content_length
            chunk_size = 8192
            while remaining > 0:
                chunk = f.read(min(chunk_size, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)
    
    def end_headers(self):
        """Add CORS headers to all responses"""
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Range')
        super().end_headers()
    
    def do_OPTIONS(self):
        """Handle OPTIONS requests for CORS preflight"""
        self.send_response(200)
        self.end_headers()
    
    def log_message(self, format, *args):
        """Custom log format"""
        sys.stdout.write(f"[{self.log_date_time_string()}] {args[0]}\n")
        sys.stdout.flush()

def main():
    parser = argparse.ArgumentParser(description='Simple Media Server for WebChat')
    parser.add_argument('--port', type=int, default=18791, help='Port to run the server on')
    parser.add_argument('--directory', default='.', help='Directory to serve media from')
    parser.add_argument('--max-depth', type=int, default=2, help='Maximum directory depth to scan (default: 2)')
    args = parser.parse_args()
    
    # Change to the specified directory
    os.chdir(args.directory)
    
    # Store args for access in handler
    global global_args
    global_args = args
    
    server = HTTPServer(('0.0.0.0', args.port), MediaServerHandler)
    
    print(f"\n🎵 Media Server Started")
    print(f"   Directory: {os.getcwd()}")
    print(f"   Port: {args.port}")
    print(f"   Max Depth: {args.max_depth} directory levels")
    print(f"   URL: http://localhost:{args.port}")
    print(f"\n   Status page: http://localhost:{args.port}/")
    print(f"\n   Supported formats:")
    print(f"   📷 Images: jpg, png, gif, webp, svg, bmp")
    print(f"   🎵 Audio: mp3, wav, ogg, flac, m4a, aac, opus, wma")
    print(f"   🎬 Video: mp4, webm, avi, mov, mkv, m4v, mpg, mpeg")
    print(f"\n   Features:")
    print(f"   - Range requests for seeking in audio/video")
    print(f"   - CORS enabled")
    print(f"   - No file size limits")
    print(f"   - Paginated file listing (20 per page)")
    print(f"   - Limited to {args.max_depth} directory depth")
    print(f"\n   Press Ctrl+C to stop\n")
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n\n👋 Server stopped")
        server.shutdown()

if __name__ == '__main__':
    main()
