# currentmain.py (Updated: Fix widget embedding for file download)
# --------------------------------------------------------------------
# CustomTkinter front‑end with red progress bar and safer file render
# --------------------------------------------------------------------

import queue, secrets, sys, os, tkinter as tk
from tkinter import filedialog
from PIL import Image, ImageTk
import customtkinter as ctk
from peer_connector import PeerConnector

# ────────────────────────── username prompt ─────────────────────────
class UsernameDialog(ctk.CTkToplevel):
    def __init__(self, master, cb):
        super().__init__(master)
        self.title("Choose username")
        self.geometry("300x120")
        self.resizable(False, False)
        self.cb = cb

        ctk.CTkLabel(self, text="Enter your username:").pack(pady=(18, 4))
        self.e = ctk.CTkEntry(self, width=180)
        self.e.pack(pady=(0, 12))
        self.e.insert(0, "User" + secrets.token_hex(2))
        self.e.focus()

        ctk.CTkButton(self, text="Continue", command=self._ok).pack()
        self.protocol("WM_DELETE_WINDOW", lambda: sys.exit(0))
        self.grab_set()

    def _ok(self):
        u = self.e.get().strip()
        if u:
            self.cb(u)
            self.destroy()

# ───────────────────────────── GUI app ──────────────────────────────
ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("blue")

class ChatGUI(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.title("Secure P2P Chat")
        self.geometry("640x500")
        self.username = None
        self.connector = None
        self.gui_q = queue.Queue()

        self.frames = {}
        for F in (ChatFrame,):
            f = F(self, self)
            self.frames[F.__name__] = f
            f.place(relx=0, rely=0, relwidth=1, relheight=1)

        self.withdraw()
        self.after(100, lambda: UsernameDialog(self, self._set_username))
        self.after(100, self._pump)

    def _set_username(self, u: str):
        self.username = u
        self.connector = PeerConnector(self.gui_q, self.username)
        self.deiconify()
        self.frames["ChatFrame"].status("Joined room – click Ready when both clients are running.")

    def _pump(self):
        while not self.gui_q.empty():
            m = self.gui_q.get_nowait()
            if m["kind"] == "chat":
                self.frames["ChatFrame"].append(m["data"])
            elif m["kind"] == "status":
                self.frames["ChatFrame"].status(m["data"])
            elif m["kind"] == "file":
                self.frames["ChatFrame"].render_file(m["data"])
        self.after(100, self._pump)

class ChatFrame(ctk.CTkFrame):
    def __init__(self, p, c):
        super().__init__(p)
        self.c = c

        self.log = ctk.CTkTextbox(self, width=600, height=300, wrap="word", state="normal")
        self.log.pack(pady=(10, 4))

        row = ctk.CTkFrame(self, fg_color="transparent")
        row.pack(fill="x", padx=8)

        self.inp = ctk.CTkEntry(row)
        self.inp.pack(side="left", fill="x", expand=True, padx=(0, 6))
        self.inp.bind("<Return>", lambda _e: self._send())

        ctk.CTkButton(row, text="Send", width=80, command=self._send).pack(side="right")

        self.ready_btn = ctk.CTkButton(self, text="Ready", width=120, command=self._ready)
        self.ready_btn.pack(pady=6)

        ctk.CTkButton(self, text="Disconnect", width=120, command=self._disc).pack(pady=2)
        self.file_btn = ctk.CTkButton(self, text="Send File", width=120, command=self._send_file)
        self.file_btn.pack(pady=2)

        self.st = ctk.CTkLabel(self, text="")
        self.st.pack()

        self.tunnel_status = ctk.CTkLabel(self, text="🌐 Using signaling server", text_color="gray")
        self.tunnel_status.pack(pady=(4, 6))

        self.progress_bar = ctk.CTkProgressBar(self, width=300, progress_color="red")
        self.progress_bar.set(0)
        self.progress_bar.pack(pady=(2, 8))

    def _ready(self):
        self.c.connector.click_ready()
        self.ready_btn.configure(state="disabled")

    def _send(self):
        txt = self.inp.get().strip()
        if txt:
            self.c.connector.send_message(txt)
            self.append(f"<{self.c.username}> {txt}")
            self.inp.delete(0, "end")

    def append(self, msg):
        self.log.insert("end", msg + "\n")
        self.log.see("end")

    def status(self, txt):
        self.st.configure(text=txt)
        if "Receiving" in txt and "%" in txt:
            try:
                percent = int(txt.split(":")[1].split("%")[0].strip())
                self.progress_bar.set(percent / 100.0)
            except:
                pass

    def update_tunnel_status(self, private=False):
        if private:
            self.tunnel_status.configure(text="🔐 Private tunnel active", text_color="green")
        else:
            self.tunnel_status.configure(text="🌐 Using signaling server", text_color="gray")

    def _disc(self):
        self.c.connector.disconnect()
        self.append("-- disconnected --")
        self.status("Connection closed")

    def _send_file(self):
        path = filedialog.askopenfilename()
        if path:
            self.c.connector.send_file(path)
            self.append(f"<{self.c.username}> [you sent a file] {os.path.basename(path)}")

    def render_file(self, fileinfo):
        ext = fileinfo["ext"].lower()
        path = fileinfo["path"]
        name = fileinfo["name"]

        if ext in [".png", ".jpg", ".jpeg", ".gif"]:
            img = Image.open(path)
            img.thumbnail((200, 200))
            img_tk = ImageTk.PhotoImage(img)
            self.append(f"[Image Received] {name}")
            self.log.insert("end", f"[Open manually in downloads/] {name}\n")
        else:
            self.append(f"[File Received] {name}")
            self.log.insert("end", f"[Open manually in downloads/] {name}\n")
        self.log.see("end")

# ─────────────────────────────── main ───────────────────────────────
if __name__ == "__main__":
    if sys.version_info < (3, 8):
        tk.messagebox.showerror("Python 3.8+ required", "Install a newer Python.")
        sys.exit(1)
    ChatGUI().mainloop()