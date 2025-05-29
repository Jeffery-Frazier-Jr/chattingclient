# peer_connector.py (Chunked File Transfer Integrated)
# --------------------------------------------------------------------
# P2P logic with progress tracking and chunked file transfer
# --------------------------------------------------------------------

import asyncio, json, queue, random, threading, base64, os, time
import websockets
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCConfiguration, RTCIceServer

SIGNAL_URL = "wss://thing-1-gzkh.onrender.com"
STUN = RTCConfiguration([RTCIceServer("stun:stun.l.google.com:19302")])
FIXED_ROOM = "one"
CHUNK_SIZE = 64000

class PeerConnector:
    def __init__(self, gui_q: queue.Queue, username: str):
        self.gui_q, self.username = gui_q, username
        self.room = FIXED_ROOM
        self.pc, self.dc = RTCPeerConnection(STUN), None
        self.pending_msgs = []
        self.ready = False
        self.peer_ready = False
        self.offer_sent = False
        self.offer_received = False
        self.ws = None
        self.closed = False
        self.file_chunks = {}

        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, daemon=True).start()
        asyncio.run_coroutine_threadsafe(self._run(), self.loop)

    def click_ready(self):
        self.ready = True
        self._post("status", "You are ready – waiting for peer…")
        if self.ws:
            self.loop.call_soon_threadsafe(
                asyncio.create_task,
                self.ws.send(json.dumps({"type": "ready", "room": self.room}))
            )

    def send_message(self, txt: str):
        if not txt: return
        if self.dc and self.dc.readyState == "open":
            self.loop.call_soon_threadsafe(
                self.dc.send,
                json.dumps({"username": self.username, "msg": txt})
            )
        else:
            self.pending_msgs.append(txt)

    def send_file(self, filepath):
        if not os.path.isfile(filepath): return
        filename = os.path.basename(filepath)
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
        self.gui_q.put({"kind": kind, "data": data})

    async def _run(self):
        self._post("status", f"Connecting to signalling server – room '{self.room}'…")
        try:
            async with websockets.connect(SIGNAL_URL) as ws:
                self.ws = ws
                await ws.send(json.dumps({"type": "join", "room": self.room}))
                if self.ready:
                    await ws.send(json.dumps({"type": "ready", "room": self.room}))

                async for raw in ws:
                    msg = json.loads(raw)
                    t = msg.get("type")

                    if t == "ready":
                        self.peer_ready = True
                        self._post("status", "Peer is ready.")
                        self._maybe_begin_offer_race()
                    elif t == "offer":
                        self.offer_received = True
                        await self._handle_offer(msg["data"])
                    elif t == "answer":
                        await self._handle_answer(msg["data"])
        except Exception as e:
            self._post("status", f"Signalling error: {e}")
        finally:
            self._post("status", "Signalling connection closed")

    def _maybe_begin_offer_race(self):
        if self.ready and self.peer_ready and not (self.offer_sent or self.offer_received):
            delay = random.uniform(0, 0.5)
            self.loop.call_later(delay, lambda: asyncio.create_task(self._try_send_offer()))

    async def _try_send_offer(self):
        if self.offer_received or self.offer_sent: return
        self.offer_sent = True
        self.dc = self.pc.createDataChannel("chat")
        self._wire_dc(self.dc)
        await self.pc.setLocalDescription(await self.pc.createOffer())
        await self.ws.send(json.dumps({
            "type": "offer",
            "room": self.room,
            "data": {
                "sdp": self.pc.localDescription.sdp,
                "type": self.pc.localDescription.type,
            },
        }))
        self._post("status", "Offer sent – waiting for answer…")

    async def _handle_offer(self, offer):
        await self.pc.setRemoteDescription(RTCSessionDescription(**offer))
        @self.pc.on("datachannel")
        def _on_dc(dc):
            self.dc = dc
            self._wire_dc(dc)
        await self.pc.setLocalDescription(await self.pc.createAnswer())
        await self.ws.send(json.dumps({
            "type": "answer",
            "room": self.room,
            "data": {
                "sdp": self.pc.localDescription.sdp,
                "type": self.pc.localDescription.type,
            },
        }))
        self._post("status", "Answer sent – awaiting channel open…")

    async def _handle_answer(self, ans):
        await self.pc.setRemoteDescription(RTCSessionDescription(**ans))
        self._post("status", "Answer accepted – awaiting channel open…")

    def _wire_dc(self, dc):
        @dc.on("open")
        def _open():
            self._post("status", "-- channel open --")
            dc.send(json.dumps({"username_announce": self.username}))
            for txt in self.pending_msgs:
                dc.send(json.dumps({"username": self.username, "msg": txt}))
            self.pending_msgs.clear()

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
                    self.file_chunks[key]["chunks"][data["chunk_id"]] = base64.b64decode(data["data"])

                    received = len(self.file_chunks[key]["chunks"])
                    total = self.file_chunks[key]["total"]
                    percent = round(received / total * 100)
                    elapsed = time.time() - self.file_chunks[key]["start_time"]
                    speed = sum(len(c) for c in self.file_chunks[key]["chunks"].values()) / max(elapsed, 0.1)

                    self._post("status", f"Receiving {key}: {percent}% ({int(speed/1024)} KB/s)")

                    if received == total:
                        os.makedirs("downloads", exist_ok=True)
                        path = os.path.join("downloads", key)
                        with open(path, "wb") as f:
                            for i in range(total):
                                f.write(self.file_chunks[key]["chunks"][i])
                        self._post("chat", f"<peer> [file] {key}")
                        self._post("file", {"path": path, "ext": self.file_chunks[key]["ext"], "name": key})
                        del self.file_chunks[key]
                elif data.get("system") == "disconnect":
                    self._post("chat", "----disconnected----")
                    self._post("status", "Peer disconnected")
                elif data.get("username_announce"):
                    self._post("status", f"Peer’s username: {data['username_announce']}")
                elif data.get("msg"):
                    self._post("chat", f"<{data.get('username','peer')}> {data['msg']}")
            except Exception as e:
                self._post("chat", f"<peer> [error parsing message] {e}")
