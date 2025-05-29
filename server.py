import asyncio, json, websockets

ROOMS: dict[str, set[websockets.WebSocketServerProtocol]] = {}

async def handler(ws, _path):
    room = None
    try:
        async for raw in ws:
            msg = json.loads(raw)
            if msg["type"] == "join":
                # create / enter room
                room = msg["room"]
                ROOMS.setdefault(room, set()).add(ws)
            else:
                # relay to the other peer(s) in the room
                targets = ROOMS.get(room, set()) - {ws}
                await asyncio.gather(*(t.send(raw) for t in targets))
    finally:
        if room and ws in ROOMS.get(room, ()):
            ROOMS[room].discard(ws)
            if not ROOMS[room]:
                del ROOMS[room]

async def main():
    print("Signalling server listening on port8080 …")
    async with websockets.serve(handler, "0.0.0.0", 8080):
        await asyncio.Future()        # run forever

if name == "main":
    asyncio.run(main())