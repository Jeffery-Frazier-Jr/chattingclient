"""
Core P2P WebRTC connection and data handling logic for the Flask Chat App.

This module defines `FlaskPeerConnector`, which manages WebRTC peer connections
using `aiortc`, handles signaling via a WebSocket connection to a separate
signaling server, and facilitates data channel communication for chat messages
and file transfers. It runs its own asyncio event loop in a separate thread.
"""
import asyncio, json, random, threading, base64, os, time, secrets
import websockets
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCConfiguration, RTCIceServer

SIGNAL_URL = "wss://thing-1-gzkh.onrender.com"
STUN = RTCConfiguration([RTCIceServer("stun:stun.l.google.com:19302")])
FIXED_ROOM = "one"
CHUNK_SIZE = 64000
RECEIVED_FILES_DIR = "flask_chat_app/received_files"

class FlaskPeerConnector:
    """
    Manages a P2P WebRTC connection, including signaling, data channel setup,
    and message/file exchange. Integrates with Flask by using a Flask-Sock
    WebSocket connection (`sock`) for sending updates to the client UI.
    """
    def __init__(self, sock=None, username=None):
        """
        Initializes the FlaskPeerConnector.

        Args:
            sock: The Flask-Sock WebSocket connection object for UI updates.
                  Can be None initially and set later via `set_sock`.
            username: The username for this peer. If None, a default is generated.
        """
        self.sock = sock # WebSocket for UI communication via app.py -> _post
        self.username = username if username else "User-" + secrets.token_hex(2)
        self.room = FIXED_ROOM # Fixed room for signaling
        self.pc, self.dc = RTCPeerConnection(STUN), None
        self.pending_msgs = []
        self.ready = False
        self.peer_ready = False
        self.offer_sent = False
        self.offer_received = False
        self.ws = None
        self.closed = False
        self.file_chunks = {}

        self.loop = asyncio.new_event_loop() # Dedicated asyncio event loop
        threading.Thread(target=self.loop.run_forever, daemon=True).start() # Runs the loop in a separate thread
        asyncio.run_coroutine_threadsafe(self._run(), self.loop) # Starts the main P2P logic

    def click_ready(self):
        """
        Marks this peer as ready to start the WebRTC connection process.
        Notifies the signaling server.
        """
        self.ready = True
        self._post("status", "You are ready – waiting for peer…")
        if self.ws: # If signaling WebSocket is connected
            self.loop.call_soon_threadsafe(
                asyncio.create_task,
                self.ws.send(json.dumps({"type": "ready", "room": self.room}))
            )

    def send_message(self, txt: str):
        """
        Sends a text message over the WebRTC data channel.
        If the data channel is not yet open, messages are queued.

        Args:
            txt: The text message to send.
        """
        if not txt: return
        if self.dc and self.dc.readyState == "open":
            self.loop.call_soon_threadsafe(
                self.dc.send,
                json.dumps({"username": self.username, "msg": txt}) # Send as JSON with username
            )
        else:
            self.pending_msgs.append(txt) # Queue if data channel not ready

    def send_file(self, filepath):
        """
        Sends a file over the WebRTC data channel in chunks.

        Args:
            filepath: The path to the file to be sent.
        """
        if not os.path.isfile(filepath):
            self._post("status", f"Error: File not found for sending: {filepath}")
            return
        
        filename = os.path.basename(filepath) # Filename may have been secured by app.py
        ext = os.path.splitext(filename)[1].lower()
        with open(filepath, "rb") as f:
            raw = f.read()

        chunks = [raw[i:i+CHUNK_SIZE] for i in range(0, len(raw), CHUNK_SIZE)]
        total = len(chunks)
        now = time.time()

        for i, chunk in enumerate(chunks):
            encoded = base64.b64encode(chunk).decode()
            payload = {
                "type": "file_chunk",
                "filename": filename,
                "ext": ext,
                "chunk_id": i,
                "total_chunks": total,
                "data": encoded,
                "timestamp": now
            }
            if self.dc and self.dc.readyState == "open":
                self.loop.call_soon_threadsafe(self.dc.send, json.dumps(payload))

    def disconnect(self):
        async def _disc():
            if self.closed: return
            if self.dc and self.dc.readyState == "open":
                self.dc.send(json.dumps({"system": "disconnect"}))
            self._post("chat", "----disconnected----")
            self._post("status", "Disconnected")
            self.closed = True
            if self.pc: await self.pc.close()
            if self.ws: await self.ws.close()
            self.ws = None
        self.loop.call_soon_threadsafe(asyncio.create_task, _disc())

    def _post(self, kind, data=""):
        """
        Sends a message to the frontend client via the Flask-Sock WebSocket.

        Args:
            kind: The type of message (e.g., 'status', 'chat', 'file').
            data: The payload of the message.
        """
        if self.sock: # If client WebSocket is connected
            try:
                self.sock.send(json.dumps({"kind": kind, "data": data})) # Send JSON to client
            except Exception as e:
                print(f"Error sending message via WebSocket: {e}")
        else:
            # This print is useful for debugging if the frontend WebSocket isn't connected
            print(f"FlaskPeerConnector (no UI sock): kind='{kind}', data='{data}'")

    def set_sock(self, sock):
        """
        Sets the Flask-Sock WebSocket connection object for this peer.

        Args:
            sock: The WebSocket connection object from Flask-Sock.
                  If None, indicates the client disconnected.
        """
        self.sock = sock
        if sock:
            self._post("status", "WebSocket connected to backend.")
            print(f"FlaskPeerConnector ({self.username}): WebSocket connection set.")
        else:
            # This occurs if the client's WebSocket disconnects from app.py
            print(f"FlaskPeerConnector ({self.username}): WebSocket connection removed.")
            # Consider if any P2P cleanup is needed if UI disconnects but P2P is active.
            # For now, P2P session can continue; user might reconnect WS.

    def set_username(self, username: str):
        """
        Sets the username for this peer.

        Args:
            username: The new username string.
        """
        if username:
            old_username = self.username
            self.username = username
            # Status update about username change is handled by app.py after calling this.
            print(f"FlaskPeerConnector: Username changed from '{old_username}' to '{self.username}'")


    async def _run(self):
        """
        Main asynchronous method that connects to the signaling server
        and handles incoming signaling messages (offers, answers, readiness).
        This runs in the dedicated asyncio event loop.
        """
        self._post("status", f"Connecting to signalling server – room '{self.room}'…")
        try:
            # Establish connection to the external WebSocket signaling server
            async with websockets.connect(SIGNAL_URL) as ws:
                self.ws = ws # Store signaling server WebSocket connection
                await ws.send(json.dumps({"type": "join", "room": self.room})) # Join the predefined room
                if self.ready:
                    await ws.send(json.dumps({"type": "ready", "room": self.room}))

                # Listen for messages from the signaling server
                async for raw in ws:
                    msg = json.loads(raw)
                    t = msg.get("type")

                    if t == "ready": # Peer has signaled readiness
                        self.peer_ready = True
                        self._post("status", "Peer is ready.")
                        self._maybe_begin_offer_race() # Attempt to start offer if both are ready
                    elif t == "offer": # Received an offer from peer
                        self.offer_received = True
                        await self._handle_offer(msg["data"])
                    elif t == "answer": # Received an answer from peer
                        await self._handle_answer(msg["data"])
        except Exception as e:
            self._post("status", f"Signalling error: {e}") # Inform UI of signaling issues
        finally:
            self._post("status", "Signalling connection closed")
            self.ws = None # Clear signaling WebSocket

    def _maybe_begin_offer_race(self):
        """
        Initiates the WebRTC offer process if both peers are ready and no offer
        has been sent or received yet. Includes a random delay to prevent glare
        (both peers sending offers simultaneously).
        """
        if self.ready and self.peer_ready and not (self.offer_sent or self.offer_received):
            # Random delay to avoid both peers sending offer at the exact same time ("glare")
            delay = random.uniform(0, 0.5) # Short delay
            self.loop.call_later(delay, lambda: asyncio.create_task(self._try_send_offer()))

    async def _try_send_offer(self):
        """
        Creates and sends a WebRTC offer to the peer via the signaling server.
        This is called after the random delay in `_maybe_begin_offer_race`.
        """
        if self.offer_received or self.offer_sent: return # Avoid if offer already handled
        self.offer_sent = True
        self.dc = self.pc.createDataChannel("chat") # Create the data channel
        self._wire_dc(self.dc) # Set up data channel event handlers

        await self.pc.setLocalDescription(await self.pc.createOffer()) # Create and set local SDP offer
        # Send the offer to the peer via the signaling server
        await self.ws.send(json.dumps({
            "type": "offer",
            "room": self.room,
            "data": {
                "sdp": self.pc.localDescription.sdp,
                "type": self.pc.localDescription.type,
            },
        }))
        self._post("status", "Offer sent – waiting for answer…")

    async def _handle_offer(self, offer_data):
        """
        Handles an incoming WebRTC offer from the peer. Sets remote description,
        creates an answer, and sends it back via the signaling server.

        Args:
            offer_data: The SDP offer data from the peer.
        """
        await self.pc.setRemoteDescription(RTCSessionDescription(**offer_data))

        # When the offer is received, the data channel is created by the offering peer.
        # The answering peer listens for it.
        @self.pc.on("datachannel")
        def _on_dc(dc):
            self.dc = dc
            self._wire_dc(dc) # Wire up the received data channel

        await self.pc.setLocalDescription(await self.pc.createAnswer()) # Create and set local SDP answer
        # Send the answer to the peer via the signaling server
        await self.ws.send(json.dumps({
            "type": "answer",
            "room": self.room,
            "data": {
                "sdp": self.pc.localDescription.sdp,
                "type": self.pc.localDescription.type,
            },
        }))
        self._post("status", "Answer sent – awaiting channel open…")

    async def _handle_answer(self, answer_data):
        """
        Handles an incoming WebRTC answer from the peer. Sets remote description.

        Args:
            answer_data: The SDP answer data from the peer.
        """
        await self.pc.setRemoteDescription(RTCSessionDescription(**answer_data))
        self._post("status", "Answer accepted – awaiting channel open…")

    def _wire_dc(self, dc):
        """
        Sets up event handlers for the WebRTC data channel (`dc`).

        Args:
            dc: The `RTCDataChannel` instance.
        """
        @dc.on("open")
        def _open():
            """Handles data channel 'open' event."""
            self._post("status", "-- channel open --")
            dc.send(json.dumps({"username_announce": self.username})) # Announce username to peer
            for txt in self.pending_msgs:
                dc.send(json.dumps({"username": self.username, "msg": txt}))
            self.pending_msgs.clear()

        @dc.on("close")
        def _close():
            self._post("status", "Data channel closed with peer.")
            print(f"DataChannel closed with {self.username}'s peer")

        @dc.on("message")
        def _msg(payload):
            try:
                data = json.loads(payload)
                if data.get("type") == "file_chunk":
                    key = data["filename"]
                    if key not in self.file_chunks:
                        self.file_chunks[key] = {
                            "ext": data["ext"],
                            "total": data["total_chunks"],
                            "chunks": {},
                            "start_time": data["timestamp"]
                        }
                    # Store the chunk
                    self.file_chunks[key]["chunks"][data["chunk_id"]] = base64.b64decode(data["data"])

                    # Progress update
                    received_chunks = len(self.file_chunks[key]["chunks"])
                    total_chunks = self.file_chunks[key]["total"]
                    percent_complete = round(received_chunks / total_chunks * 100)
                    elapsed_time = time.time() - self.file_chunks[key]["start_time"]
                    bytes_received = sum(len(c) for c in self.file_chunks[key]["chunks"].values())
                    # Avoid division by zero if elapsed_time is very small
                    speed_kbps = (bytes_received / 1024) / max(elapsed_time, 0.001)

                    self._post("status", f"Receiving {key}: {percent_complete}% ({int(speed_kbps)} KB/s)")

                    # Check if all chunks received
                    if received_chunks == total_chunks:
                        os.makedirs(RECEIVED_FILES_DIR, exist_ok=True)
                        file_path = os.path.join(RECEIVED_FILES_DIR, key) # `key` is the filename
                        
                        # Assemble and save the file
                        with open(file_path, "wb") as f:
                            for i in range(total_chunks):
                                f.write(self.file_chunks[key]["chunks"][i])
                        
                        # Notify UI about file completion and download readiness
                        chat_msg_data = {"username": "Peer", "msg": f"[file] '{key}' received. Download link available."}
                        self._post("chat", chat_msg_data)
                        self._post("file", {"name": key, "ext": self.file_chunks[key]["ext"]})
                        
                        del self.file_chunks[key] # Clean up stored chunks for this file
                
                elif data.get("system") == "disconnect": # Peer initiated disconnect
                    self._post("chat", "----disconnected----")
                    self._post("status", "Peer disconnected")
                    # Consider closing local DC and PC if peer explicitly disconnects via system message
                    # self.closed = True # This is handled in disconnect()
                    # self.loop.call_soon_threadsafe(asyncio.create_task, self.pc.close())
                
                elif data.get("username_announce"): # Peer announced its username
                    self._post("status", f"Peer’s username: {data['username_announce']}")
                
                elif data.get("msg"): # Regular chat message
                    chat_data = {"username": data.get('username', 'peer'), "msg": data['msg']}
                    self._post("chat", chat_data)
            
            except Exception as e:
                # Handle errors in processing messages from peer
                error_msg_data = {"username": "System", "msg": f"[Error processing peer message: {str(e)}]"}
                self._post("chat", error_msg_data)
