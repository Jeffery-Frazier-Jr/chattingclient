"""
Main Flask application file for the P2P WebRTC Chat.

This file sets up the Flask server, handles HTTP routes for user actions
(like setting username, sending messages/files, readiness), manages WebSocket
connections for real-time updates from the PeerConnector, and serves
the frontend HTML, CSS, and JavaScript.
"""
import asyncio
import base64
import json
import os
import threading
import time # Added time for potential use, though not explicitly in list

from flask import Flask, render_template, request, jsonify, send_from_directory
from flask_sock import Sock
from werkzeug.utils import secure_filename

# Assuming flask_peer_connector is in the same directory
# If FLASK_APP is set to flask_chat_app.app and run from parent dir, this should work.
# Otherwise, adjustments might be needed e.g. if app.py is run directly.
try:
    from .flask_peer_connector import FlaskPeerConnector
except ImportError:
    # Fallback for direct execution or different project structure
    from flask_peer_connector import FlaskPeerConnector

APP_ROOT = os.path.dirname(os.path.abspath(__file__))
# This RECEIVED_FILES_DIR_APP is where app.py will look for files to serve.
# It must correspond to where FlaskPeerConnector saves files.
# FlaskPeerConnector saves to "flask_chat_app/received_files".
# If app.py is in flask_chat_app, then "received_files" is correct.
RECEIVED_FILES_DIR_APP = os.path.join(APP_ROOT, "received_files")


app = Flask(__name__)
app.config['SECRET_KEY'] = os.urandom(24) # Good practice, though not strictly for WebSockets yet
sock = Sock(app)

# Global instance of PeerConnector
# The asyncio loop for peer_connector is started within its own __init__.
# sock and username are set dynamically.
peer_connector = FlaskPeerConnector(sock=None, username=None)

# --- Basic Routes ---
@app.route('/')
def index():
    """Serves the main HTML page of the chat application."""
    return render_template('index.html')

# --- WebSocket Route ---
@sock.route('/ws')
def ws_chat(ws):
    """
    Handles the WebSocket connection for a client.

    This route is managed by Flask-Sock. When a client connects to '/ws',
    this function is called with the WebSocket connection object (`ws`).
    The connection is passed to the `FlaskPeerConnector` instance to enable
    server-to-client communication for WebRTC signaling and chat updates.
    The loop keeps the connection alive, listening for any messages from the client
    (though most client actions are via HTTP POST).
    """
    print("WebSocket connection established.")
    peer_connector.set_sock(ws) # Associate this WebSocket with the PeerConnector
    try:
        while True:
            data = ws.receive(timeout=None) # Block until message or timeout (None = no timeout)
            if data:
                # Handle messages from client via WebSocket if necessary
                # For now, most interaction is via HTTP, this is mainly for PeerConnector -> Client
                print(f"Received message via WebSocket from client: {data}")
                # Example: client sends a JSON ping
                try:
                    client_msg = json.loads(data)
                    if client_msg.get("type") == "ping":
                        peer_connector._post("pong", "PONG from server")
                except json.JSONDecodeError:
                    pass # Not a JSON message
            else:
                # ws.receive() returns None if the client closed the connection cleanly
                print("WebSocket client appears to have closed the connection (received None).")
                break
    except ConnectionResetError: # More specific than just Exception for this case
        print("Client disconnected from WebSocket (ConnectionResetError).")
    except websockets.exceptions.ConnectionClosedOK: # Handle normal closure
        print("WebSocket connection closed normally by client.")
    except Exception as e:
        print(f"WebSocket error: {e}")
    finally:
        print("WebSocket connection closing procedures.")
        peer_connector.set_sock(None) # Disassociate on disconnect/error


# --- Action Routes (HTTP POST) ---
@app.route('/set-username', methods=['POST'])
def set_username_route():
    """
    Sets the username for the client session in the PeerConnector.
    Expects JSON: {"username": "desired_username"}
    Returns JSON: {"status": "username set", "username": "..."} or error.
    """
    data = request.get_json()
    username = data.get('username')
    if username:
        peer_connector.set_username(username)
        # Notify the client via WebSocket that the username has been set.
        peer_connector._post("status", f"Username set to: {username}")
        return jsonify({"status": "username set", "username": username})
    return jsonify({"status": "error", "message": "Username not provided"}), 400

@app.route('/ready', methods=['POST'])
def ready_route():
    """
    Signals that the client is ready for P2P connection.
    No request data expected.
    Returns JSON: {"status": "ready signal processed"}.
    """
    print("Ready signal received from client.")
    peer_connector.click_ready()
    return jsonify({"status": "ready signal processed"})

@app.route('/send-message', methods=['POST'])
def send_message_route():
    """
    Sends a chat message from the client to the peer.
    Expects JSON: {"message": "text_message"}
    Returns JSON: {"status": "message sent"} or error.
    """
    data = request.get_json()
    message = data.get('message')
    if message is not None: # Allow empty messages
        peer_connector.send_message(message)
        return jsonify({"status": "message sent"})
    return jsonify({"status": "error", "message": "Message not provided"}), 400

UPLOAD_FOLDER = 'flask_chat_app/uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER

@app.route('/send-file', methods=['POST'])
def send_file_route():
    if 'file' not in request.files:
        return jsonify({"status": "error", "message": "No file part"}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({"status": "error", "message": "No selected file"}), 400
    if file:
        filename = secure_filename(file.filename)
        if not filename:
            return jsonify({"status": "error", "message": "Invalid filename provided"}), 400
        
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        try:
            file.save(filepath)
            print(f"File saved to: {filepath}")
            # Instruct PeerConnector to initiate P2P file transfer
            peer_connector.send_file(filepath)
            return jsonify({"status": "file upload received, attempting to send", "filename": filename})
        except Exception as e:
            print(f"Error saving or sending file: {e}")
            # It's good practice to log the actual exception e to the server logs
            return jsonify({"status": "error", "message": f"Could not process file: {str(e)}"}), 500
    return jsonify({"status": "error", "message": "File operation failed"}), 500


@app.route('/disconnect', methods=['POST'])
def disconnect_route():
    """
    Signals the PeerConnector to disconnect the P2P session.
    No request data expected.
    Returns JSON: {"status": "disconnecting"}.
    """
    print("Disconnect signal received from client.")
    peer_connector.disconnect()
    return jsonify({"status": "disconnecting"})

# --- Download Route ---
@app.route('/download/<path:filename>')
def download_file(filename):
    """
    Serves a received file for download.
    `<path:filename>` allows filenames that might include subdirectories,
    though current implementation saves files flatly.
    Uses `send_from_directory` for secure file serving.
    """
    print(f"Download request for filename: {filename}")
    # `send_from_directory` helps prevent directory traversal.
    # Filename is already secured by `secure_filename` when initially saved by the peer connector,
    # and also by the client using encodeURIComponent when constructing the download link.
    print(f"Attempting to send file: {filename} from directory: {RECEIVED_FILES_DIR_APP}")
    try:
        return send_from_directory(directory=RECEIVED_FILES_DIR_APP, path=filename, as_attachment=True)
    except FileNotFoundError:
        print(f"File not found: {filename} in {RECEIVED_FILES_DIR_APP}")
        return jsonify({"status": "error", "message": "File not found"}), 404
    except Exception as e:
        print(f"Error during download for {filename}: {e}")
        return jsonify({"status": "error", "message": f"Could not process download: {e}"}), 500


# --- Running the App ---
if __name__ == '__main__':
    # Ensure upload and received directories exist
    # UPLOAD_FOLDER is defined above as 'flask_chat_app/uploads'
    # If app.py is in flask_chat_app, then UPLOAD_FOLDER becomes os.path.join(APP_ROOT, "uploads")
    
    # FlaskPeerConnector creates RECEIVED_FILES_DIR ("flask_chat_app/received_files") when it saves a file.
    # app.py needs RECEIVED_FILES_DIR_APP for serving. We ensure it exists on startup too.
    
    uploads_dir = os.path.join(APP_ROOT, "uploads") # Corresponds to UPLOAD_FOLDER logic
    
    os.makedirs(uploads_dir, exist_ok=True)
    os.makedirs(RECEIVED_FILES_DIR_APP, exist_ok=True)
    
    print(f"Uploads directory: {uploads_dir}")
    print(f"Received files directory (for serving): {RECEIVED_FILES_DIR_APP}")
    print("Starting Flask app...")
    app.run(host='0.0.0.0', port=5000, debug=True, use_reloader=False)
